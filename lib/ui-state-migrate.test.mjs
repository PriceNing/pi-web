// ui-state-migrate 的测试：全部对临时目录里的副本操作，绝不碰真实 ~/.pi/agent/。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const migrate = await jiti.import("./ui-state-migrate.ts");
const { planLegacyMigration, legacyTimestampToEpochMs, migrateLegacyUiState } = migrate;
const { readSessionUiState, getSessionUiStatePath } = await jiti.import("./session-ui-state.ts");

const ISO_A = "2024-01-02T03:04:05.000Z"; // epoch ms 1704164645000
const ISO_B = "2024-03-01T00:00:00.000Z"; // 更早
const ISO_C = "2024-05-01T00:00:00.000Z"; // 更晚
const STAMP = 1700000000000; // 注入用的固定 UTC 毫秒戳（改名后缀确定性）

/** 最小 SessionInfo 形状（字段与 lib/types.ts 对齐），供族归并/workspaceKeyOf 使用。 */
function fakeSession(id, cwd, relation) {
  return {
    id,
    path: `${tmpdir()}/fake/${id}.jsonl`,
    cwd,
    created: "2024-01-01T00:00:00.000Z",
    modified: "2024-01-01T00:00:00.000Z",
    messageCount: 0,
    firstMessage: "hi",
    ...(relation ? { relation } : {}),
  };
}

const SUBAGENT_OF = (parent) => ({ kind: "subagent", parentSessionId: parent });

function freshAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-migrate-"));
  mkdirSync(join(dir, "pi-web"), { recursive: true });
  return dir;
}

function writePins(agentDir, obj) {
  writeFileSync(join(agentDir, "pi-web", "pins.json"), JSON.stringify(obj, null, 2));
}
function writeArchives(agentDir, obj) {
  writeFileSync(join(agentDir, "pi-web", "archives.json"), JSON.stringify(obj, null, 2));
}

const baseOptions = (agentDir) => ({
  agentDir,
  nowMs: () => STAMP,
  listSessions: async () => [
    fakeSession("root-a", "C:/proj-x"),
    fakeSession("sib-b", "C:/proj-x", SUBAGENT_OF("root-a")),
    fakeSession("root-y", "C:/proj-y"),
    fakeSession("kid-y", "C:/proj-y", SUBAGENT_OF("root-y")),
  ],
});

// ---------------------------------------------------------------------------
// 纯规划器
// ---------------------------------------------------------------------------

test("族归并：同族兄弟 pin 折叠成一条，时间戳取族内最早（稳定可复现）", () => {
  const plan = planLegacyMigration({
    pins: { version: 1, sessions: { "sib-b": { pinnedAt: ISO_C }, "root-a": { pinnedAt: ISO_B } }, projects: {} },
    archives: null,
    sessions: [
      fakeSession("root-a", "C:/proj-x"),
      fakeSession("sib-b", "C:/proj-x", SUBAGENT_OF("root-a")),
    ],
  });
  assert.equal(plan.sessions.length, 1);
  assert.equal(plan.sessions[0].id, "root-a"); // 落键在 FAMILY ROOT
  assert.equal(plan.sessions[0].pinnedAt, Date.parse(ISO_B)); // 族内最早
  assert.equal(plan.counts.mergedSessions, 1);
  // 同一输入跑两遍结果一致（确定性）。
  const again = planLegacyMigration({
    pins: { version: 1, sessions: { "root-a": { pinnedAt: ISO_B }, "sib-b": { pinnedAt: ISO_C } }, projects: {} },
    archives: null,
    sessions: [fakeSession("root-a", "C:/proj-x"), fakeSession("sib-b", "C:/proj-x", SUBAGENT_OF("root-a"))],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(again.sessions)), JSON.parse(JSON.stringify(plan.sessions)));
});

test("孤儿 id：不在会话列表里的键保留原样落键并计数报数", () => {
  const plan = planLegacyMigration({
    pins: { version: 1, sessions: { "ghost-id": { pinnedAt: ISO_A } }, projects: {} },
    archives: null,
    sessions: [fakeSession("root-a", "C:/proj-x")],
  });
  assert.equal(plan.sessions.length, 1);
  assert.equal(plan.sessions[0].id, "ghost-id"); // 原样保留
  assert.equal(plan.counts.orphanIdsKept, 1);
  assert.equal(plan.counts.orphansNotPatternSafe, 0); // ghost-id 匹配 SESSION_ID_PATTERN
});

test("ISO→epoch ms 转换；非法/空时间串返回 null（调用方据此跳过+计数）", () => {
  assert.equal(legacyTimestampToEpochMs(ISO_A), 1704164645000);
  assert.equal(legacyTimestampToEpochMs(1704164645000), 1704164645000);
  assert.equal(legacyTimestampToEpochMs(""), null);
  assert.equal(legacyTimestampToEpochMs("not a date"), null);
  assert.equal(legacyTimestampToEpochMs(undefined), null);
});

test("非法时间串的条目被跳过且计入警告计数，合法条目照常迁移", () => {
  const plan = planLegacyMigration({
    pins: { version: 1, sessions: { "root-a": { pinnedAt: "" }, "sib-b": { pinnedAt: "garbage" }, "root-y": { pinnedAt: ISO_A } }, projects: {} },
    archives: null,
    sessions: [
      fakeSession("root-a", "C:/proj-x"),
      fakeSession("sib-b", "C:/proj-x", SUBAGENT_OF("root-a")),
      fakeSession("root-y", "C:/proj-y"),
    ],
  });
  assert.equal(plan.counts.invalidTimestampsSkipped, 2);
  assert.equal(plan.warnings.filter((w) => /unparsable/.test(w)).length, 2);
  assert.deepEqual(plan.sessions.map((e) => e.id), ["root-y"]); // 只有合法的那条活下来
});

test("语义位移：项目级归档 → 该项目下每个会话族各占一条 archivedAt（沿用旧项目级时间）", () => {
  const plan = planLegacyMigration({
    pins: null,
    archives: { version: 1, projects: { "C:/proj-y": { archivedAt: ISO_B } } },
    sessions: [
      fakeSession("root-y", "C:/proj-y"),
      fakeSession("kid-y", "C:/proj-y", SUBAGENT_OF("root-y")),
      fakeSession("root-a", "C:/proj-x"),
    ],
  });
  // 一族一条（不是每个成员一条），键在族根。
  assert.deepEqual(plan.sessions.map((e) => e.id), ["root-y"]);
  assert.equal(plan.sessions[0].archivedAt, Date.parse(ISO_B));
  // 没有可见族的归档项目无处落键：跳过并计数。
  const orphanProject = planLegacyMigration({
    pins: null,
    archives: { version: 1, projects: { "C:/nowhere": { archivedAt: ISO_B } } },
    sessions: [fakeSession("root-a", "C:/proj-x")],
  });
  assert.equal(orphanProject.counts.archiveProjectsDroppedNoFamilies, 1);
  assert.equal(orphanProject.sessions.length, 0);
});

test("截断有计数不静默：条目数上限挤掉的条目在返回值里明确报告", () => {
  const plan = planLegacyMigration({
    pins: {
      version: 1,
      sessions: { "id-1": { pinnedAt: ISO_A }, "id-2": { pinnedAt: ISO_B }, "id-3": { pinnedAt: ISO_C } },
      projects: {},
    },
    archives: null,
    sessions: [], // 三个都按孤儿保留落键
    limits: { maxMergedSessions: 2 },
  });
  assert.equal(plan.counts.mergedSessions, 3);
  assert.equal(plan.counts.truncatedByCount.sessions, 1); // 明确报数，绝不静默
  assert.equal(plan.sessions.length, 2);
});

// ---------------------------------------------------------------------------
// IO 层（全部对临时目录操作）
// ---------------------------------------------------------------------------

test("端到端：pins+archives 迁移进目标文件，时间戳精确、改名产物命名正确、源文件留审计痕迹", async () => {
  const agentDir = freshAgentDir();
  writePins(agentDir, { version: 1, sessions: { "sib-b": { pinnedAt: ISO_C } }, projects: { "C:/proj-x": { pinnedAt: ISO_B } } });
  writeArchives(agentDir, { version: 1, projects: { "C:/proj-y": { archivedAt: ISO_A } } });
  const before = { pins: readFileSync(join(agentDir, "pi-web", "pins.json"), "utf8"), archives: readFileSync(join(agentDir, "pi-web", "archives.json"), "utf8") };

  const result = await migrateLegacyUiState(baseOptions(agentDir));
  assert.equal(result.action, "migrated");
  assert.ok(!result.error, result.error ?? "");
  assert.ok(result.requestsExecuted >= 2); // ≥ restore + pin-project

  const state = readSessionUiState(getSessionUiStatePath(agentDir));
  // 会话旗标走 restore：保住精确时间戳；族归并落在根上。
  assert.equal(state.sessions["root-a"].pinnedAt, Date.parse(ISO_C));
  assert.equal(state.sessions["root-y"].archivedAt, Date.parse(ISO_A));
  // 项目 pin 直接进 projects：键逐字照搬，root 反查自会话目录；pinnedAt 是迁移时刻（语义限制）。
  const project = state.projects["C:/proj-x"];
  assert.ok(project);
  assert.equal(project.root, "C:/proj-x");
  assert.ok(Number.isFinite(project.pinnedAt) && project.pinnedAt > 0);
  assert.ok(state.revision >= 2, `revision=${state.revision}`); // 每次改变的写入都 bump

  // 改名产物：<原名>.migrated-<UTC毫秒>，不是删除！
  const stampedPins = join(agentDir, "pi-web", `pins.json.migrated-${STAMP}`);
  const stampedArchives = join(agentDir, "pi-web", `archives.json.migrated-${STAMP}`);
  assert.ok(stampedPins.match(/pins\.json\.migrated-\d{13}$/), stampedPins); // UTC 毫秒戳后缀
  assert.deepEqual([...result.renamed].sort(), [stampedArchives, stampedPins].sort());
  for (const path of [stampedArchives, stampedPins]) assert.ok(existsSync(path), `${path} 应存在（改名而非删除）`);
  for (const name of ["pins.json", "archives.json"]) {
    assert.ok(!existsSync(join(agentDir, "pi-web", name)), `${name} 应已被改名而非删除`);
  }
  assert.equal(readFileSync(join(agentDir, "pi-web", `pins.json.migrated-${STAMP}`), "utf8"), before.pins);
  assert.equal(readFileSync(join(agentDir, "pi-web", `archives.json.migrated-${STAMP}`), "utf8"), before.archives);
});

test("目标已存在 → 拒写 skipped，两个源原样不动", async () => {
  const agentDir = freshAgentDir();
  writePins(agentDir, { version: 1, sessions: { "root-a": { pinnedAt: ISO_A } }, projects: {} });
  writeArchives(agentDir, { version: 1, projects: { "C:/proj-y": { archivedAt: ISO_A } } });
  const target = getSessionUiStatePath(agentDir);
  const targetText = JSON.stringify({ version: 1, revision: 42, sessions: {}, projects: {} });
  writeFileSync(target, targetText);

  const result = await migrateLegacyUiState(baseOptions(agentDir));
  assert.equal(result.action, "skipped");
  assert.equal(result.reason, "target-exists");
  assert.equal(result.requestsExecuted, 0);
  assert.deepEqual(result.renamed, []);
  assert.equal(readFileSync(target, "utf8"), targetText); // 绝不覆盖已有目标
  assert.equal(JSON.parse(readFileSync(join(agentDir, "pi-web", "pins.json"), "utf8")).version, 1); // 源未动
  assert.ok(existsSync(join(agentDir, "pi-web", "archives.json")));
});

test("两源皆空 → no-op，连目标文件都不创建", async () => {
  const agentDir = freshAgentDir();
  writePins(agentDir, { version: 1, sessions: {}, projects: {} });
  writeArchives(agentDir, { version: 1, projects: {} });
  const result = await migrateLegacyUiState(baseOptions(agentDir));
  assert.equal(result.action, "noop");
  assert.equal(result.requestsExecuted, 0);
  assert.ok(!existsSync(getSessionUiStatePath(agentDir)));
});

test("解析失败的那一侧原地不动（绝不清洗），另一侧照常迁移且只有它被改名", async () => {
  const agentDir = freshAgentDir();
  const pinsPath = join(agentDir, "pi-web", "pins.json");
  writeFileSync(pinsPath, "{ this is not jsonc ");
  writeArchives(agentDir, { version: 1, projects: { "C:/proj-y": { archivedAt: ISO_A } } });

  const result = await migrateLegacyUiState(baseOptions(agentDir));
  assert.equal(result.action, "migrated");
  assert.ok(!result.error, result.error ?? "");
  assert.ok(result.warnings.some((w) => w.includes(pinsPath) && /unreadable/.test(w)), JSON.stringify(result.warnings));
  assert.equal(readFileSync(pinsPath, "utf8"), "{ this is not jsonc "); // 原地不动
  assert.deepEqual(result.renamed, [join(agentDir, "pi-web", `archives.json.migrated-${STAMP}`)]); // 只改有贡献的
  const state = readSessionUiState(getSessionUiStatePath(agentDir));
  assert.equal(state.sessions["root-y"].archivedAt, Date.parse(ISO_A));
});

test("截断发生时明确报数且不静默：报告了数字并且不改动/不留名丢失的条目", async () => {
  const agentDir = freshAgentDir();
  writePins(agentDir, { version: 1, sessions: { "id-1": { pinnedAt: ISO_A }, "id-2": { pinnedAt: ISO_B } }, projects: {} });
  const options = baseOptions(agentDir);
  options.limits = { maxMergedSessions: 1 };
  const result = await migrateLegacyUiState(options);
  assert.equal(result.action, "migrated");
  assert.equal(result.plan.counts.truncatedByCount.sessions, 1); // 明确报告
  assert.equal(result.plan.sessions.length, 1);
  // 本实现的规则：发生了截断丢条目 → 源文件留在原地等人工复核，不改名。
  assert.deepEqual(result.renamed, []);
  assert.ok(existsSync(join(agentDir, "pi-web", "pins.json")));
  const state = readSessionUiState(getSessionUiStatePath(agentDir));
  assert.equal(Object.keys(state.sessions).length, 1); // 计划里保留的那条落盘了
});

test("幂等：第二次运行什么都不做", async () => {
  const agentDir = freshAgentDir();
  writePins(agentDir, { version: 1, sessions: { "root-a": { pinnedAt: ISO_A } }, projects: { "C:/proj-x": { pinnedAt: ISO_A } } });
  writeArchives(agentDir, { version: 1, projects: { "C:/proj-y": { archivedAt: ISO_A } } });

  const first = await migrateLegacyUiState(baseOptions(agentDir));
  assert.equal(first.action, "migrated");
  const target = getSessionUiStatePath(agentDir);
  const afterFirst = readFileSync(target, "utf8");

  const second = await migrateLegacyUiState({ ...baseOptions(agentDir), nowMs: () => STAMP + 1 });
  assert.equal(second.action, "skipped");
  assert.equal(second.reason, "target-exists");
  assert.equal(second.requestsExecuted, 0);
  assert.deepEqual(second.renamed, []);
  assert.equal(readFileSync(target, "utf8"), afterFirst); // 一字未改
});
