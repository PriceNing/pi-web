// [fork] 看门狗的单元测试：纯逻辑，不碰网络。
import test from "node:test";
import assert from "node:assert/strict";
import { latestScheduledRun, evaluate } from "../scripts/check-sync-watchdog.mjs";

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
