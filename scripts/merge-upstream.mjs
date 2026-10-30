#!/usr/bin/env node
// [fork] 策略化的上游合并：把「方向已定」的冲突按既定方向自动解掉，
// 只把真正需要人来判断的冲突留下来，并且**让它可见**（开 issue + 步骤注解）。
//
// 为什么需要它（2026-10 连续断更的根因）：
//   1) 我们的 README.md 是 fork 的门面，上游每次改它就撞一次冲突，
//      workflow「冲突即停」于是连着几晚不发版；
//   2) 上游重写 app/api/sessions/[id]/route.ts 这类文件时，我们那点残留接线
//      也会变成冲突，但方向其实早已定死（取上游）；
//   3) 冲突时 workflow 只在日志里留一行，人不盯着就看不到，于是「安静地断更」；
//   4) 每次发版 CI 会往 main 推一个 `chore(release)` 标记，本地再推自己的合并
//      就会被判非快进——所以本地合并前必须先把这枚标记合进来。
//
// 本地一条命令搞定 4 件事：
//   node scripts/merge-upstream.mjs
//     ① fetch origin 并把 origin/main（含 release 标记）合进来
//     ② fetch upstream（不取 tag）
//     ③ 合并 upstream/main，按策略自动解冲突
//     ④ 把结果写进 .merge-upstream-report.json（供 CI 读 incoming 数）
//
// 退出码：0 = 合并完成；2 = 有需要判断的冲突（已开 issue，合并状态保留在原地）。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergePackageJson } from "./merge-package-json.mjs";

const ROOT = process.cwd();
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * 方向已定的路径。键是相对仓库根的路径，值是 "ours" 或 "theirs"。
 * 改动这个表之前先想清楚：这个文件以后会不会再和上游打架。
 *
 * ours   = 取我们这一侧（fork 门面，方向永不变）
 * theirs = 取上游那一侧（上游负责的文件，方向永不变）
 */
export const POLICY = {
  // fork 的门面：永远是我们的。上游改它只是改上游自己的首页说明。
  "README.md": "ours",
  "README.zh-CN.md": "ours",
  "README.ja.md": "ours",
  "README.ru.md": "ours",
  // 上游自己的文档译文（在 docs/ 下，是上游首页的多语言版，不是我们的门面）。
  "docs/README.ja.md": "theirs",
  "docs/README.ru.md": "theirs",
  "docs/README.zh-CN.md": "theirs",
  // 上游负责的文件，我们的残留接线已挪走（lib/session-delete-compat.ts）。
  "app/api/sessions/[id]/route.ts": "theirs",
  "lib/session-delete.ts": "theirs",
  // package-lock.json：它必须**重新生成**，不能合并。
  // 它的 name 字段写死了包名（上游 @agegr/pi-web，我们 @pricening/pi-web），
  // 所以它与上游必然冲突；而合并 lock 出来的结果是错的（哈希对不上我们的包名）。
  // 正确做法是合成 package.json 之后 `npm install` 重新生成 lock。
  // 这里取 theirs 只是为了让合并能往下走，生成的 lock 会被 npm install 覆盖。
  "package-lock.json": "theirs",
  // 我们的流水线（2026-10-30 钉住）：
  //
  // 上游 v0.13.0 把自己的发版换成了「推 v* tag → publish.yml」，并**删掉了**它
  // 那份 sync-upstream.yml（上游自己的文件，名字和我们的一样）。如果不钉住，
  // 这次合并会把我们的同步+发版流水线整个删掉 —— fork 就没有自动同步了。
  //
  // publish.yml 也钉成 ours：上游新增了同名文件（发它自己的 @agegr/pi-web），
  // 但我们的 publish.yml 是 fork 专用的「手动重发通道」，而且刻意不监听 tag，
  // 免得和 sync-upstream.yml 抢同一个版本号（第二个进程必撞 E409）。
  ".github/workflows/sync-upstream.yml": "ours",
  ".github/workflows/publish.yml": "ours",
};

/**
 * 必须留在仓库里的文件：上游删掉它们时，合并脚本把它们恢复回来。
 *
 * 起因（2026-10-14，上游 7cc1803）：上游把多语言 README 挪进了 docs/，
 * 那次提交是「重命名 + 删除」——它自己的三个译文被搬走了，
 * 而我们 fork 的 README.zh-CN.md 因为内容不同没被一起搬走，于是被单独删除。
 * 我们的英文门面还指着它，链接当场变成死链，中文门面就此消失。
 * 门面是 fork 的资产，不能由上游顺手删掉，所以这里钉住。
 */
export const MUST_KEEP = [
  "README.md",
  "README.zh-CN.md",
  "README.ja.md",
  "README.ru.md",
  "docs/FORK.md",
  // 我们的同步与发版流水线。上游 v0.13.0 删掉了它自己的 sync-upstream.yml
  // （与我们的同名），如果不在这里钉住，下次合并就会把 fork 的自动同步删掉 ——
  // 而删掉之后 GitHub 不会报错，只是定时任务再也不跑，非常难发现。
  ".github/workflows/sync-upstream.yml",
  ".github/workflows/publish.yml",
];

/**
 * 门面的权威副本所在的 tag。
 *
 * 为什么要有它：门面的恢复源不能只靠“合并前的 HEAD”——那要求文件当时就在
 * 历史里。而我们在 0.12.1 基线上恰好已经丢了中文门面（上游那次删除已经
 * 发生），此时无论怎么“恢复”都恢复不出来。给门面打一个 tag，内容就与
 * 历史深度无关：以后任何一次合并删掉门面，都能从这个 tag 取回。
 */
export const FRONT_DOORS_TAG = "fork-front-doors";

/**
 * 从给定的候选 ref 里取回一个必须保留的文件。
 * 依次尝试：合并前的 ref、门面的 tag。都不行就放弃（不猜内容）。
 * 返回是否恢复成功。
 */
function restoreFileFrom(cwd, file, refs) {
  const git = makeGit(cwd);
  for (const ref of refs) {
    if (!ref) continue;
    const has = git.safe(["cat-file", "-e", `${ref}:${file}`]);
    if (!has.ok) continue;
    const checkout = git.safe(["checkout", ref, "--", file]);
    if (checkout.ok) return true;
  }
  return false;
}

export const REPORT_FILE = ".merge-upstream-report.json";

function makeGit(cwd) {
  const run = (args, options = {}) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  const safe = (args) => {
    try {
      return { ok: true, out: run(args) };
    } catch (error) {
      return { ok: false, out: String(error.stdout ?? "") + String(error.stderr ?? ""), error };
    }
  };
  return { run, safe };
}

/** 冲突文件列表（合并进行中时）。 */
export function conflictedFiles(cwd = ROOT) {
  const git = makeGit(cwd);
  const result = git.safe(["diff", "--name-only", "--diff-filter=U"]);
  if (!result.ok) return [];
  return result.out.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * 按策略解决冲突，返回 { resolved, manual }。
 * resolved：策略定死的文件；manual：需要人判断的文件。
 */
export function resolveByPolicy(files, { cwd = ROOT, policy = POLICY, dryRun = false } = {}) {
  const git = makeGit(cwd);
  const resolved = [];
  const manual = [];
  for (const file of files) {
    // package.json 走结构化合并：我们的身份 + 上游的依赖。
    // 整块取 ours/theirs 都会丢东西（见 scripts/merge-package-json.mjs）。
    if (file === "package.json") {
      if (dryRun) {
        resolved.push(file);
        continue;
      }
      const ours = git.safe(["show", ":2:package.json"]);
      const theirs = git.safe(["show", ":3:package.json"]);
      if (!ours.ok || !theirs.ok) {
        manual.push(file);
        continue;
      }
      const merged = mergePackageJson(
        JSON.parse(ours.out),
        JSON.parse(theirs.out),
      );
      writeFileSync(join(cwd, "package.json"), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
      git.run(["add", "--", file]);
      resolved.push(file);
      continue;
    }
    const side = policy[file];
    if (!side) {
      manual.push(file);
      continue;
    }
    if (!dryRun) {
      // ours/theirs 指合并的两端：ours = 我们的 main，theirs = upstream/main。
      git.run(["checkout", `--${side}`, "--", file]);
      git.run(["add", "--", file]);
    }
    resolved.push(file);
  }
  return { resolved, manual };
}

/** 把这次合并的结果记进一个文件，方便事后查，也让 CI 读得到 incoming。 */
export function writeReport({ resolved, manual, incoming }, cwd = ROOT) {
  const path = join(cwd, REPORT_FILE);
  const report = {
    at: new Date().toISOString(),
    incoming,
    resolvedByPolicy: resolved,
    needsDecision: manual,
  };
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

export function readReport(cwd = ROOT) {
  const path = join(cwd, REPORT_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 把当前的门面内容打进 `fork-front-doors` tag。
 *
 * 这个 tag 是门面的权威副本：以后任何一次合并（包括折进 origin/main）把门面
 * 删掉了，都能从它取回。tag 指向一次专门的提交，所以它不会随 main 移动。
 */
export function sealFrontDoors(cwd = ROOT, { mustKeep = MUST_KEEP } = {}) {
  const git = makeGit(cwd);
  const existing = mustKeep.filter((file) => existsSync(join(cwd, file)));
  if (existing.length === 0) return { sealed: false, files: [] };
  // 用**临时索引**建树：`git write-tree` 写的是索引，而工作区里刚改好的门面
  // 未必已经进索引；直接 `git add` 到真实索引又会在合并进行中时添乱。
  const tmpIndex = join(cwd, ".git", "front-doors-index");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  // read-tree HEAD 在空仓库（还没有任何提交）上会失败；那种情况下没什么可封存的。
  const readTree = execFileSync("git", ["read-tree", "HEAD"], {
    cwd,
    env,
    encoding: "utf8",
    stdio: "ignore",
  });
  void readTree;
  execFileSync("git", ["add", "--", ...existing], { cwd, env, encoding: "utf8", stdio: "ignore" });
  const tree = execFileSync("git", ["write-tree"], { cwd, env, encoding: "utf8" }).trim();
  const commit = execFileSync("git", ["commit-tree", tree, "-m", "fork: seal the front doors"], {
    cwd,
    env,
    encoding: "utf8",
  }).trim();
  const tagged = git.safe(["tag", "-f", FRONT_DOORS_TAG, commit]);
  // 清理临时索引：它可能不存在（git 有时不写），所以用 -f 且不报错。
  try {
    execFileSync("git", ["rm", "-f", "--quiet", tmpIndex], { cwd, encoding: "utf8", stdio: "ignore" });
  } catch { /* 临时索引没生成就算了 */ }
  if (!tagged.ok) return { sealed: false, files: [] };
  return { sealed: true, files: existing, commit };
}

/** 冲突要人来判断时，开一个 issue，别让它安静地断更。 */
function openIssue(manual, cwd = ROOT) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;
  const title = `上游合并需要判断：${manual.length} 个文件`;
  const body = [
    "定时同步在上游合并处停下了，方向已定的冲突已自动解决，剩下这些需要人来判断：",
    "",
    ...manual.map((file) => `- \`${file}\``),
    "",
    "处理方式见 docs/FORK.md §12：",
    "本地跑 `node scripts/merge-upstream.mjs`，解完提交并推送，",
    "再手动触发一次发版：",
    "`gh workflow run sync-upstream.yml --repo PriceNing/pi-web --ref main -f force_publish=true`。",
  ].join("\n");
  try {
    const git = makeGit(cwd);
    git.run(["config", "user.name", "github-actions[bot]"]);
    git.run(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    execFileSync("gh", ["issue", "create", "--repo", "PriceNing/pi-web", "--title", title, "--body", body], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_TOKEN: token },
    });
  } catch (error) {
    console.warn(`[merge-upstream] 开 issue 失败（不影响合并结果）: ${String(error?.message ?? error)}`);
  }
}

/**
 * 上游把我们的门面删掉（或改名搬走）时，把它恢复回来。
 *
 * 两种情形都要管：
 *   a) 文件在工作区里没了（合并把它删了）——从合并前的 ref 或 tag 取回；
 *   b) 文件成了 modify/delete 冲突——git 不会把它列进 --diff-filter=U，
 *      因为它把「上游删除」直接应用了，这时要显式 checkout 我们这一侧。
 *
 * 恢复源依次是：合并前的提交、门面的 tag（fork-front-doors）。
 * 不能只靠合并前的提交：门面可能在更早的时候就已经从历史里消失了
 * （上游 2026-10-14 那次删除），那时前一个 ref 里根本没有它。
 * 返回被恢复的文件名列表。
 */
export function restoreMustKeep(cwd = ROOT, { ref, mustKeep = MUST_KEEP } = {}) {
  const git = makeGit(cwd);
  const restored = [];
  for (const file of mustKeep) {
    // 上游那边还有**同名**文件且我们这边也有 → 那是普通冲突，交给策略流程。
    const theirsHas = git.safe(["cat-file", "-e", `upstream/main:${file}`]);
    const oursHas = git.safe(["cat-file", "-e", `HEAD:${file}`]);

    // 情形 b：合并把这个文件删了（上游删或改名），而我们这边还有。
    const deletedInMerge = git.safe(["diff", "--name-only", "--diff-filter=D", "HEAD"]);
    const wasDeleted = deletedInMerge.ok && deletedInMerge.out.split("\n").map((l) => l.trim()).includes(file);
    if (wasDeleted && oursHas.ok && !theirsHas.ok) {
      if (restoreFileFrom(cwd, file, [ref, FRONT_DOORS_TAG])) {
        git.run(["add", "--", file]);
        restored.push(file);
        continue;
      }
    }

    // 情形 a：工作区里直接没了（合并结果里就没有它）。
    if (existsSync(join(cwd, file))) continue;
    if (theirsHas.ok) continue;
    if (restoreFileFrom(cwd, file, [ref, FRONT_DOORS_TAG])) {
      git.run(["add", "--", file]);
      restored.push(file);
    }
  }
  return restored;
}

/**
 * 同步上游：先折进 origin/main 的 release 标记，再按策略合并 upstream/main。
 * 返回 { incoming, resolved, manual, ok }。
 */
export function syncUpstream({ cwd = ROOT, dryRun = false, fetchOrigin = true } = {}) {
  const git = makeGit(cwd);
  const notes = [];

  if (fetchOrigin) {
    const fetched = git.safe(["fetch", "--no-tags", "--prune", "origin"]);
    if (!fetched.ok) notes.push("fetch origin 失败（继续）");
    const ahead = git.safe(["rev-list", "--count", "HEAD..origin/main"]);
    if (ahead.ok && Number(ahead.out.trim() || "0") > 0) {
      // origin/main 上多出来的多半是 CI 推的 `chore(release)` 标记。
      // 不先折进来，后面的 push 会被判非快进。
      //
      // 门面的恢复源在折进**之前**就要记下来：折进去之后 HEAD 里可能已经没有
      // 我们的门面了（上游那次「重命名 + 删除」会把 README.zh-CN.md 一起带走）。
      const beforeOriginMerge = git.safe(["rev-parse", "HEAD"]).out.trim();
      let merged = git.safe(["merge", "--no-edit", "origin/main"]);
      if (!merged.ok) {
        // git 报 "would be overwritten by merge"：这不是真冲突，
        // 是 origin/main 删了某个我们还有的文件。先把门面的那一侧让出来再合。
        const deleted = git.safe(["diff", "--name-only", "--diff-filter=D", "origin/main..HEAD"]);
        const vanished = deleted.ok
          ? deleted.out.split("\n").map((line) => line.trim()).filter(Boolean)
          : [];
        for (const file of vanished) {
          if (!MUST_KEEP.includes(file)) continue;
          git.safe(["checkout", "HEAD", "--", file]);
        }
        merged = git.safe(["merge", "--no-edit", "origin/main"]);
      }
      if (!merged.ok) {
        notes.push("合 origin/main 失败，请手工处理");
        writeReport({ resolved: [], manual: [], incoming: 0 }, cwd);
        return { incoming: 0, resolved: [], manual: [], ok: false, notes };
      }
      // 折进来之后立刻把门面找回来。
      const doorsBack = restoreMustKeep(cwd, { ref: beforeOriginMerge });
      if (doorsBack.length > 0) {
        git.run(["add", "--", ...doorsBack]);
        git.safe(["commit", "--no-edit", "-m", "chore(fork): keep the fork's README front doors"]);
        notes.push(`折进 origin/main 后恢复了门面: ${doorsBack.join(", ")}`);
      }
      notes.push("已折进 origin/main（含发版标记）");
    }
  }

  const fetchedUpstream = git.safe([
    "fetch",
    "--no-tags",
    "--prune",
    "upstream",
    "+refs/heads/main:refs/remotes/upstream/main",
  ]);
  if (!fetchedUpstream.ok) {
    notes.push("fetch upstream 失败");
    writeReport({ resolved: [], manual: [], incoming: 0 }, cwd);
    return { incoming: 0, resolved: [], manual: [], ok: false, notes };
  }

  const incomingResult = git.safe(["rev-list", "--count", "HEAD..upstream/main"]);
  const incoming = incomingResult.ok ? Number(incomingResult.out.trim() || "0") : 0;
  if (incoming === 0) {
    notes.push("上游无新提交");
    // 就算没有新东西可合，也封存一次门面：万一上次封存之后门面被改过，
    // 权威副本要跟着更新，否则恢复时会拿到旧版本。
    sealFrontDoors(cwd);
    writeReport({ resolved: [], manual: [], incoming: 0 }, cwd);
    return { incoming: 0, resolved: [], manual: [], ok: true, notes };
  }

  const preMergeRef = git.safe(["rev-parse", "HEAD"]).out.trim();

  // 合并前先看一眼门面在不在：
  //   - 上游若删掉（而不是改名）它，合并会直接把它删了，合并后恢复；
  //   - 若它**在合并前就已经缺失**（历史上丢过，比如新克隆的仓库），那合并后
  //     也不会有它可恢复——必须现在就从 fork-front-doors tag 取回。
  const missingBefore = MUST_KEEP.filter(
    (file) => !existsSync(join(cwd, file)) && !git.safe(["cat-file", "-e", `upstream/main:${file}`]).ok,
  );
  if (missingBefore.length > 0) {
    const back = restoreMustKeep(cwd, { ref: preMergeRef, mustKeep: missingBefore });
    if (back.length > 0) {
      git.run(["add", "--", ...back]);
      git.safe(["commit", "--no-edit", "-m", "chore(fork): restore the fork's README front doors"]);
      notes.push(`合并前恢复了缺失的门面: ${back.join(", ")}`);
    } else {
      notes.push(`警告：门面缺失且找不到副本: ${missingBefore.join(", ")}`);
    }
  }

  const merge = git.safe(["merge", "--no-edit", "upstream/main"]);
  if (merge.ok) {
    // 合上了也可能「悄悄」删掉了我们的门面（上游的重命名 + 删除）。
    const restored = restoreMustKeep(cwd, { ref: preMergeRef });
    if (restored.length > 0) {
      git.run(["add", "--", ...restored]);
      git.safe(["commit", "--no-edit", "-m", "chore(fork): keep the fork's README front doors"]);
      notes.push(`恢复了被上游删掉的门面: ${restored.join(", ")}`);
    }
    sealFrontDoors(cwd);
    notes.push("合并完成，无冲突");
    writeReport({ resolved: [], manual: [], incoming }, cwd);
    return { incoming, resolved: [], manual: [], ok: true, notes };
  }

  const files = conflictedFiles(cwd);
  if (files.length === 0) {
    // 不是冲突，而是合并本身失败（例如 unrelated histories）——
    // 这时工作区不能停在半合并状态。
    const aborted = git.safe(["merge", "--abort"]);
    if (!aborted.ok) {
      // 没有可中止的合并（例如它根本没开始），把索引清干净。
      git.safe(["reset", "--hard", "HEAD"]);
    }
    notes.push("合并失败（不是冲突）——工作区已恢复，可能的原因：历史无共同祖先、磁盘权限、index 锁");
    const restored = restoreMustKeep(cwd, { ref: preMergeRef });
    if (restored.length > 0) {
      git.run(["add", "--", ...restored]);
      notes.push(`恢复了被上游删掉的门面: ${restored.join(", ")}`);
    }
    writeReport({ resolved: [], manual: [], incoming }, cwd);
    return { incoming, resolved: [], manual: [], ok: false, notes };
  }
  const { resolved, manual } = resolveByPolicy(files, { cwd, dryRun });
  notes.push(`冲突 ${files.length} 个：策略自动解 ${resolved.length} 个，需判断 ${manual.length} 个`);

  if (dryRun) {
    writeReport({ resolved, manual, incoming }, cwd);
    return { incoming, resolved, manual, ok: manual.length === 0, notes };
  }

  if (manual.length > 0) {
    // 停下来等人判断之前，先把门面找回来：上游的删除已经被应用了，
    // 剩下的冲突文件里不包含它们，不恢复就会在本地工作区里丢掉。
    const restored = restoreMustKeep(cwd, { ref: preMergeRef });
    if (restored.length > 0) {
      git.run(["add", "--", ...restored]);
      notes.push(`恢复了被上游删掉的门面: ${restored.join(", ")}`);
    }
    writeReport({ resolved, manual, incoming }, cwd);
    openIssue(manual, cwd);
    return { incoming, resolved, manual, ok: false, notes };
  }

  const committed = git.safe(["commit", "--no-edit"]);
  if (!committed.ok) {
    notes.push("提交合并结果失败");
    return { incoming, resolved, manual, ok: false, notes };
  }
  // 冲突解完之后，门面可能已经被上游删掉了（modify/delete 冲突，git 直接应用了
  // 上游的删除），这时把它们找回来。
  const restored = restoreMustKeep(cwd, { ref: preMergeRef });
  if (restored.length > 0) {
    git.run(["add", "--", ...restored]);
    git.safe(["commit", "--no-edit", "-m", "chore(fork): keep the fork's README front doors"]);
    notes.push(`恢复了被上游删掉的门面: ${restored.join(", ")}`);
  }
  sealFrontDoors(cwd);
  writeReport({ resolved, manual, incoming }, cwd);
  return { incoming, resolved, manual, ok: true, notes };
}

function main() {
  const result = syncUpstream({ dryRun: DRY_RUN });
  for (const note of result.notes) console.log(`[merge-upstream] ${note}`);
  if (result.manual.length > 0) {
    console.error(`[merge-upstream] 需要人判断: ${result.manual.join(", ")}`);
    console.error("[merge-upstream] 已开 issue；解完提交推送后手动触发发版");
    return 2;
  }
  if (!result.ok) {
    console.error("[merge-upstream] 合并未完成");
    return 1;
  }
  console.log(`[merge-upstream] 上游新提交 ${result.incoming} 个，同步完成`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("merge-upstream.mjs")) {
  const code = main();
  if (code !== 0) process.exit(code);
}
