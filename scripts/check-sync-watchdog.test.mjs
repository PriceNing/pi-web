// [fork] 看门狗的单元测试：纯逻辑，不碰网络。
import test from "node:test";
import assert from "node:assert/strict";
import { latestScheduledRun, latestScheduledConclusion, evaluate } from "../scripts/check-sync-watchdog.mjs";

const HOUR = 3_600_000;

test("只认 schedule 事件，其他事件不算", () => {
  const payload = {
    workflow_runs: [
      { event: "push", created_at: "2026-10-29T10:00:00Z" },
      { event: "schedule", created_at: "2026-10-28T06:30:00Z" },
      { event: "workflow_dispatch", created_at: "2026-10-29T12:00:00Z" },
    ],
  };
  const latest = latestScheduledRun(payload);
  assert.equal(latest.created_at, "2026-10-28T06:30:00Z");
});

test("多条 schedule 取最新的那条", () => {
  const payload = {
    workflow_runs: [
      { event: "schedule", created_at: "2026-10-20T06:30:00Z" },
      { event: "schedule", created_at: "2026-10-25T06:30:00Z" },
      { event: "schedule", created_at: "2026-10-22T06:30:00Z" },
    ],
  };
  assert.equal(latestScheduledRun(payload).created_at, "2026-10-25T06:30:00Z");
});

test("payload 形状不对时不抛异常", () => {
  assert.equal(latestScheduledRun(null), null);
  assert.equal(latestScheduledRun({}), null);
  assert.equal(latestScheduledRun({ workflow_runs: "nope" }), null);
  assert.equal(latestScheduledRun({ workflow_runs: [{ event: "schedule" }] }), null);
});

test("最近有 schedule 运行 → 正常", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const verdict = evaluate(
    { latest: { created_at: "2026-10-29T06:30:00Z" }, now },
    { staleHours: 48 },
  );
  assert.equal(verdict.state, "ok");
  assert.equal(verdict.reason, "recent-schedule-run");
});

test("超过阈值没有 schedule 运行 → 停摆", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const verdict = evaluate(
    { latest: { created_at: "2026-10-20T06:30:00Z" }, now },
    { staleHours: 48 },
  );
  assert.equal(verdict.state, "stale");
  assert.equal(verdict.reason, "no-schedule-run");
  assert.ok(verdict.ageHours > 48);
});

test("刚好在阈值内不算停摆（边界不抖动）", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const verdict = evaluate(
    { latest: { created_at: new Date(now - 47 * HOUR).toISOString() }, now },
    { staleHours: 48 },
  );
  assert.equal(verdict.state, "ok");
});

test("从来没被调度过，但仓库很新 → 不误报", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const verdict = evaluate(
    { latest: null, anyRunCreatedAt: "2026-10-29T11:00:00Z", now },
    { staleHours: 48 },
  );
  assert.equal(verdict.state, "ok");
  assert.equal(verdict.reason, "too-new-for-schedule");
});

test("从来没被调度过，仓库已经很旧 → 停摆", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const verdict = evaluate(
    { latest: null, anyRunCreatedAt: "2026-10-01T00:00:00Z", now },
    { staleHours: 48 },
  );
  assert.equal(verdict.state, "stale");
  assert.equal(verdict.reason, "never-scheduled");
});

test("一个 run 都没有 → 判断不了，而不是报停摆", () => {
  const verdict = evaluate({ latest: null, anyRunCreatedAt: null });
  assert.equal(verdict.state, "unknown");
});

// --- 2026-11-05：调度正常但 run 失败，也是断更 -------------------------
//
// 11-02/03/04 连着三天失败（合并停在 SettingsPanel.tsx 要人判断），
// 而看门狗当时只问「有没有 schedule 运行」——run 一直有，于是它连着
// 三天报「✓ 正常」。断更就这样又静默了三天。

test("调度正常但最近一次 schedule 失败 → 报 failed，不是 ok", () => {
  const now = Date.parse("2026-11-05T00:00:00Z");
  const verdict = evaluate(
    {
      latest: { created_at: "2026-11-04T14:46:07Z" },
      latestConclusion: { conclusion: "failure" },
      now,
    },
    { staleHours: 48 },
  );
  assert.equal(verdict.state, "failed");
  assert.equal(verdict.reason, "schedule-run-failure");
});

test("最近一次 schedule 成功 → 仍然 ok", () => {
  const now = Date.parse("2026-11-05T00:00:00Z");
  const verdict = evaluate(
    {
      latest: { created_at: "2026-11-04T14:46:07Z" },
      latestConclusion: { conclusion: "success" },
      now,
    },
    { staleHours: 48 },
  );
  assert.equal(verdict.state, "ok");
});

test("没有结论信息（老 API）→ 不误报失败", () => {
  const now = Date.parse("2026-11-05T00:00:00Z");
  const verdict = evaluate(
    {
      latest: { created_at: "2026-11-04T14:46:07Z" },
      latestConclusion: null,
      now,
    },
    { staleHours: 48 },
  );
  assert.equal(verdict.state, "ok");
});

test("停摆优先于失败：很久没调度了就不再谈 run 的结论", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const verdict = evaluate(
    {
      latest: { created_at: "2026-11-04T14:46:07Z" },
      latestConclusion: { conclusion: "failure" },
      now,
    },
    { staleHours: 48 },
  );
  assert.equal(verdict.state, "stale");
});

test("latestScheduledConclusion 只看 schedule，取最新的那条", () => {
  const payload = {
    workflow_runs: [
      { event: "schedule", created_at: "2026-11-01T00:00:00Z", conclusion: "success" },
      { event: "push", created_at: "2026-11-05T00:00:00Z", conclusion: "failure" },
      { event: "schedule", created_at: "2026-11-03T00:00:00Z", conclusion: "failure" },
    ],
  };
  const run = latestScheduledConclusion(payload);
  assert.equal(run?.created_at, "2026-11-03T00:00:00Z");
  assert.equal(run?.conclusion, "failure");
});
