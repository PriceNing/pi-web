#!/usr/bin/env node
// [fork] 定时同步的看门狗 —— 不依赖 GitHub Actions。
//
// 为什么需要它（2026-10-29 实测）：
//
//   GitHub 会自动停用 fork 仓库上的 workflow（省算力策略，见 docs/FORK.md §7.8）。
//   停用之后**没有任何报错**：定时同步不再产生 run，仓库看起来一切正常，
//   只是每天的同步悄无声息地停了。上游那 7 天就是这样断更的，而且
//   「同步停了」和「上游本来就没更新」在日志里长得一模一样 —— 两者都是
//   "没有新提交"。
//
//   .github/workflows/watchdog.yml 能发现一部分情况，但它自己也是定时跑的：
//   Actions 被整体停用时它同样不会跑。**所以还需要这一层** —— 它跑在
//   机器上（生产机 / 任何能上网的机器），只靠匿名 HTTP 请求判断，
//   不需要 GitHub 凭据。
//
// 用法：
//   node scripts/check-sync-watchdog.mjs                    # 打印状态，退出码 0/1
//   node scripts/check-sync-watchdog.mjs --repo PriceNing/pi-web
//   node scripts/check-sync-watchdog.mjs --stale-hours 48
//   node scripts/check-sync-watchdog.mjs --json              # 机器可读的输出
//
// 退出码：
//   0 = 定时同步在正常被调度
//   1 = 停摆（超过阈值没有 schedule 运行）
//   2 = 判断不了（网络问题、仓库不存在、API 变了）

const DEFAULT_REPO = "PriceNing/pi-web";
const DEFAULT_WORKFLOW = "sync-upstream.yml";
const DEFAULT_STALE_HOURS = 48;

/** 匿名访问公开仓库的 run 列表 —— 不需要 token。 */
function buildRunsUrl(repo, workflow) {
  return `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=50`;
}

/**
 * 从 run 列表里挑出最近一次 schedule 运行。
 * @param {{workflow_runs?: {event?: string, created_at?: string}[]}} payload
 * @returns {{created_at: string} | null}
 */
export function latestScheduledRun(payload) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const scheduled = runs
    .filter((run) => run?.event === "schedule" && typeof run?.created_at === "string")
    .map((run) => ({ created_at: run.created_at, time: Date.parse(run.created_at) }))
    .filter((run) => Number.isFinite(run.time))
    .sort((a, b) => a.time - b.time);
  return scheduled.length > 0 ? scheduled[scheduled.length - 1] : null;
}

/**
 * 判断这次检查的结论。
 * @param {{latest: {created_at: string}|null, anyRunCreatedAt?: string|null, now?: number}} input
 * @param {{staleHours: number}} options
 */
export function evaluate(input, { staleHours = DEFAULT_STALE_HOURS } = {}) {
  const now = input.now ?? Date.now();
  if (!input.latest) {
    // 从来没被调度过。只在「仓库本身很旧」时才判定为停摆 ——
    // 刚建好的仓库当然还没有 schedule 运行。
    const any = input.anyRunCreatedAt ? Date.parse(input.anyRunCreatedAt) : NaN;
    if (!Number.isFinite(any)) {
      return { state: "unknown", reason: "no-runs-at-all", ageHours: null };
    }
    const ageHours = (now - any) / 3_600_000;
    if (ageHours <= staleHours) {
      return { state: "ok", reason: "too-new-for-schedule", ageHours };
    }
    return { state: "stale", reason: "never-scheduled", ageHours };
  }
  const ageHours = (now - Date.parse(input.latest.created_at)) / 3_600_000;
  if (ageHours > staleHours) return { state: "stale", reason: "no-schedule-run", ageHours };
  return { state: "ok", reason: "recent-schedule-run", ageHours };
}

function parseArgs(argv) {
  const args = { repo: DEFAULT_REPO, workflow: DEFAULT_WORKFLOW, staleHours: DEFAULT_STALE_HOURS, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") args.repo = argv[++i];
    else if (argv[i] === "--workflow") args.workflow = argv[++i];
    else if (argv[i] === "--stale-hours") args.staleHours = Number(argv[++i]);
    else if (argv[i] === "--json") args.json = true;
  }
  if (!Number.isFinite(args.staleHours) || args.staleHours <= 0) args.staleHours = DEFAULT_STALE_HOURS;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = buildRunsUrl(args.repo, args.workflow);

  let payload;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "pi-web-sync-watchdog",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const message = `GitHub API 返回 HTTP ${response.status}`;
      if (args.json) console.log(JSON.stringify({ state: "unknown", reason: message }));
      else console.error(`无法判断：${message}`);
      return 2;
    }
    payload = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.json) console.log(JSON.stringify({ state: "unknown", reason: message }));
    else console.error(`无法判断：${message}`);
    return 2;
  }

  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const anyRun = runs
    .map((run) => run?.created_at)
    .filter((value) => typeof value === "string")
    .sort()
    .at(-1) ?? null;

  const verdict = evaluate(
    { latest: latestScheduledRun(payload), anyRunCreatedAt: anyRun },
    { staleHours: args.staleHours },
  );

  const result = {
    ...verdict,
    repo: args.repo,
    workflow: args.workflow,
    staleHours: args.staleHours,
    latestScheduledRun: verdict.ageHours === null ? null : undefined,
    lastScheduleAt: verdict.reason === "no-schedule-run" || verdict.reason === "never-scheduled"
      ? (payload.workflow_runs ?? [])
          .filter((run) => run?.event === "schedule" && typeof run?.created_at === "string")
          .map((run) => run.created_at)
          .sort()
          .at(-1) ?? null
      : null,
  };

  if (args.json) {
    console.log(JSON.stringify(result));
  } else if (verdict.state === "ok") {
    const hours = Math.round(verdict.ageHours ?? 0);
    console.log(`✓ 定时同步正常：最近一次 schedule 运行在 ${hours} 小时前（${args.repo} / ${args.workflow}）`);
  } else if (verdict.state === "stale") {
    console.error(`✗ 定时同步已停摆：最近一次 schedule 运行是 ${Math.round(verdict.ageHours)} 小时前（阈值 ${args.staleHours} 小时）`);
    console.error("  本仓库是 fork，GitHub 会自动停用 fork 上的 workflow 来省算力。");
    console.error(`  恢复：打开 https://github.com/${args.repo}/actions ，点绿色按钮`);
    console.error('  "I understand my workflows, go ahead and re-enable them"。');
  } else {
    console.error(`无法判断：${verdict.reason}`);
  }

  return verdict.state === "ok" ? 0 : verdict.state === "stale" ? 1 : 2;
}

if (process.argv[1] && process.argv[1].endsWith("check-sync-watchdog.mjs")) {
  main().then((code) => { process.exitCode = code; });
}
