// [migration] 一次性 legacy store 迁移：把本 fork 旧的两套存储
// （getAgentDir()/pi-web/pins.json 与 archives.json）导入上游 v0.11.0 的统一
// 服务端 UI state（目标文件 getAgentDir()/pi-web-session-state.json）。
//
// 硬性安全规则逐条说明（为什么存在）：
// * 只在目标文件不存在时执行；绝不覆盖已有目标——迁移是一次性动作，目标已
//   存在说明早已迁过或用户正在用新版统一 state，覆盖会丢运行期数据。
// * 两个源都是空 → no-op（连写盘都不发生）；至少一侧有内容才动手。
// * 读取只走既有 lib/regular-file.ts + lib/jsonc.ts；解析失败或不是正则文件
//   → 那一侧原地不动、记警告，绝不清洗修复。
// * 写盘复用上游写入层 updateSessionUiState()，请求只用 session-ui-state-
//   shared.ts 里已有的动作构造："restore"（第 53 行，唯一能携带精确时间戳的
//   动作，用于全部会话旗标）与 "pin-project"（第 54 行，用于项目 pin）。
//   "set"/"add-projects"/"move-project" 用不到：前者的时间戳只能盖写入时刻，
//   后两者对应的 projectOrder 在旧格式里没有对应数据，本迁移不生成它。
// * 上限全部尊重：单请求 ≤ MAX_SESSION_UI_IDS_PER_REQUEST（超出只是分片）、
//   合并后每类条目 ≤ legacy store 自己的 500 上限、最终序列化字节 ≤ 上游
//   store 自身的 4MB 大小上限；被上限挤掉的条目数必须在返回值里明确报告，
//   不许静默截断。MAX_PROJECT_ORDER_KEYS / PROJECT_ORDER_MAX_BYTES 因不生成
//   projectOrder 而天然满足。
// * 成功后把「对最终写入有贡献」的源文件改名为 <原名>.migrated-<UTC毫秒>
//   （留审计痕迹、可回退；命名沿用 store 里 .corrupt-<ms> 的约定）。任何一
//   步失败都不改名；发生了截断丢条目也不改名——源文件留在原地等人工复核；
//   没贡献的文件（全空或全部条目被跳过）同样留在原地。
// * 幂等：第二次运行目标已存在 → skipped，什么都不做。
//
// 三条异构点的处理（照已核实的事实实现）：
// 1. 族归并：新存储只认 FAMILY ROOT 会话 id，旧 pins.sessions 的键可以是任意
//    层级。先用既有逻辑 lib/session-family.ts 把成员映射到族根再落键去重；同
//    族多个兄弟 pin 折叠成一条，时间戳取族内最早的那个（排序遍历保证稳定可
//    复现）。不在会话列表里的孤儿 id 保留原样落键并计数报数，不静默丢弃。
// 2. 时间戳：旧的 ISO 字符串 → 新的 epoch ms 数字；解析失败的条目跳过并计入
//    警告计数。注意语义限制：项目 pin 走 "pin-project"，该动作只会盖上写入
//    时刻的 pinnedAt，所以迁移后的项目 pinnedAt 是迁移时刻（旧时间串仍参与非
//    法性校验，非法则整条跳过）；会话旗标走 "restore"，能保住精确时间戳。
// 3. projectKey 两边出自同一个 workspaceKeyOf（lib/workspace-memory.ts），项
//    目键逐字照搬；root 从会话目录反查（projectRoot ?? cwd），查不到的跳过并
//    计数。
//
// 已与用户确认的语义位移：旧的「项目级归档」导入后＝该项目下所有会话族各占
// 一条 archivedAt（时间戳沿用旧的项目级时间）；没有可见族的归档项目无处落
// 键，跳过并计数。同一族若同时被单独 pin 且所属项目被归档，两个旗标都保留
// （忠实搬运数据，互斥裁决留给 UI/上游规则）。

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseJsonc } from "./jsonc";
import { readRegularFileText, PROJECT_SETTINGS_MAX_BYTES } from "./regular-file";
import { listSessionFamilies } from "./session-family";
import { workspaceKeyOf } from "./workspace-memory";
import { getSessionUiStatePath, updateSessionUiState } from "./session-ui-state";
import {
  applySessionUiStateRequest,
  chunkForSessionUiRequests,
  emptySessionUiState,
  MAX_SESSION_UI_IDS_PER_REQUEST,
  SESSION_ID_PATTERN,
  type SessionUiFlagsSnapshot,
  type SessionUiProjectState,
  type SessionUiStateRequest,
} from "./session-ui-state-shared";
import type { SessionInfo } from "./types";

/** 镜像 lib/session-ui-state.ts 内部的 MAX_BYTES（那边未导出）：超限的文件读回来是空的，必须先挤掉条目。 */
const STORE_MAX_BYTES = 4 * 1024 * 1024;
/** legacy pins/archives 各自的既有条目上限（lib/pin-order.ts / lib/archive-order.ts 里的 500）。 */
const LEGACY_MERGED_MAX = 500;
/** 字节模拟里代替真实写入时刻的近似 epoch ms（13 位十进制，位数与真实值一致即可）。 */
const APPROX_NOW_MS = 1_700_000_000_000;

const utf8 = new TextEncoder();

// ---------------------------------------------------------------------------
// 纯逻辑层（输入都是已解析好的普通对象，无 IO，便于测试）
// ---------------------------------------------------------------------------

/** 旧存储的解析结果；null = 该侧不可用（缺失/解析失败/非正则文件）。 */
export interface LegacyPinsInput {
  version?: unknown;
  sessions?: Record<string, { pinnedAt?: unknown }> | null;
  projects?: Record<string, { pinnedAt?: unknown }> | null;
}
export interface LegacyArchivesInput {
  version?: unknown;
  projects?: Record<string, { archivedAt?: unknown }> | null;
}

export interface MigrationLimits {
  /** 合并后 session 条目上限（默认沿用 legacy store 自己的 500）。 */
  maxMergedSessions?: number;
  /** 合并后 project 条目上限。 */
  maxMergedProjects?: number;
  /** 最终文件序列化后的 UTF-8 字节上限（默认镜像上游 4MB）。 */
  maxBytes?: number;
}

/** 计划条目的来源标记：改名只对「有贡献」的源进行。 */
export type LegacySourceName = "pins" | "archives";

export interface PlannedSessionEntry {
  id: string;
  pinnedAt?: number;
  archivedAt?: number;
  sources: LegacySourceName[];
  orphan: boolean;
}
export interface PlannedProjectEntry {
  key: string;
  root: string;
  sources: LegacySourceName[];
}

export interface MigrationCounts {
  mergedSessions: number;
  mergedProjects: number;
  invalidTimestampsSkipped: number;
  /** 不在会话列表里、按原样保留落键的孤儿 id 数（明确报数，不静默丢弃）。 */
  orphanIdsKept: number;
  /** 其中不匹配 SESSION_ID_PATTERN 的：目标存储在读取时会丢弃它们，单独提示。 */
  orphansNotPatternSafe: number;
  archiveProjectsDroppedNoFamilies: number;
  projectPinsDroppedNoRoot: number;
  truncatedByCount: { sessions: number; projects: number };
  truncatedByBytes: { sessions: number; projects: number };
}

export interface MigrationPlan {
  /** 通过全部校验与上限、将被写入的条目（均已排序保证可复现）。 */
  sessions: PlannedSessionEntry[];
  projects: PlannedProjectEntry[];
  counts: MigrationCounts;
  warnings: string[];
}

/**
 * ISO 字符串 → epoch ms；也容忍直接的数字。空串/不可解析/负数 → null，调用方
 * 据此跳过该条并计入警告计数。Date.parse 对无时区串按本机时区解释——旧存储本
 * 来就只写带 Z 的 ISO 串，这里只做格式级把关，不做时区猜测。
 */
export function legacyTimestampToEpochMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** 旧格式里一条记录：时间戳是不可信的原始值，逐条校验后才参与写入。 */
type LegacyEntry = { pinnedAt?: unknown; archivedAt?: unknown };

function sortedEntries(record: Record<string, LegacyEntry> | null | undefined): Array<[string, LegacyEntry]> {
  // 键逐字照搬，但排序遍历，保证合并与截断结果稳定可复现。
  return Object.entries(record ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordOf(raw: unknown): Record<string, LegacyEntry> {
  return isPlainObject(raw) ? (raw as Record<string, LegacyEntry>) : {};
}

function workspaceKeyOfSession(session: SessionInfo): string {
  return workspaceKeyOf({
    cwd: session.cwd,
    projectRoot: (session as { projectRoot?: string | null }).projectRoot,
    projectKey: (session as { projectKey?: string | null }).projectKey,
  });
}

/**
 * 纯规划器：已解析的源数据 + 会话目录 → 迁移计划（含全部计数与警告）。
 * sessions 需带 relation/modified 等字段，供 listSessionFamilies 与
 * workspaceKeyOf 复用既有逻辑；孤儿（不在列表里的 id）不参与归并、原样保留。
 */
export function planLegacyMigration(input: {
  pins: LegacyPinsInput | null;
  archives: LegacyArchivesInput | null;
  sessions: readonly SessionInfo[];
  limits?: MigrationLimits;
}): MigrationPlan {
  const limits = input.limits ?? {};
  const maxSessions = limits.maxMergedSessions ?? LEGACY_MERGED_MAX;
  const maxProjects = limits.maxMergedProjects ?? LEGACY_MERGED_MAX;
  const maxBytes = limits.maxBytes ?? STORE_MAX_BYTES;
  const warnings: string[] = [];
  const counts: MigrationCounts = {
    mergedSessions: 0,
    mergedProjects: 0,
    invalidTimestampsSkipped: 0,
    orphanIdsKept: 0,
    orphansNotPatternSafe: 0,
    archiveProjectsDroppedNoFamilies: 0,
    projectPinsDroppedNoRoot: 0,
    truncatedByCount: { sessions: 0, projects: 0 },
    truncatedByBytes: { sessions: 0, projects: 0 },
  };

  // 族归并基础设施：成员 id → FAMILY ROOT id（复用 lib/session-family.ts），
  // projectKey → 该项目的族根集合（族的归属按族根的 workspaceKeyOf 判定）。
  const families = listSessionFamilies(input.sessions);
  const memberToRoot = new Map<string, string>();
  for (const family of families) {
    memberToRoot.set(family.root.id, family.root.id);
    for (const member of family.subagents) memberToRoot.set(member.id, family.root.id);
  }
  const rootsByProject = new Map<string, Set<string>>();
  for (const family of families) {
    const key = workspaceKeyOfSession(family.root);
    if (!rootsByProject.has(key)) rootsByProject.set(key, new Set());
    rootsByProject.get(key)!.add(family.root.id);
  }
  const rootPathByKey = new Map<string, string>();
  for (const session of [...input.sessions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const key = workspaceKeyOfSession(session);
    if (!rootPathByKey.has(key)) rootPathByKey.set(key, (session as { projectRoot?: string }).projectRoot ?? session.cwd);
  }

  interface MergeCell { pinnedAt?: number; archivedAt?: number; orphan: boolean; sources: Set<LegacySourceName> }
  const merged = new Map<string, MergeCell>();
  const mergeFlag = (id: string, field: "pinnedAt" | "archivedAt", at: number, source: LegacySourceName, orphan: boolean) => {
    let cell = merged.get(id);
    if (!cell) {
      cell = { orphan, sources: new Set() };
      merged.set(id, cell);
    }
    const current = cell[field];
    // 同族折叠取最早时间戳——稳定、可复现。
    if (current === undefined || at < current) cell[field] = at;
    cell.sources.add(source);
  };

  // --- 旧 pins.sessions：任意层级 id → 族根落键 ------------------------------
  for (const [id, value] of sortedEntries(recordOf(input.pins?.sessions))) {
    const at = legacyTimestampToEpochMs(value?.pinnedAt);
    if (at === null) {
      counts.invalidTimestampsSkipped++;
      warnings.push(`pins.sessions["${id}"]: unparsable timestamp, entry skipped`);
      continue;
    }
    let finalId = memberToRoot.get(id);
    let orphan = false;
    if (finalId === undefined) {
      finalId = id; // 孤儿：保留原样落键并计数，不静默丢弃
      orphan = true;
      counts.orphanIdsKept++;
      if (!SESSION_ID_PATTERN.test(id) || id === "__proto__") {
        counts.orphansNotPatternSafe++;
        warnings.push(`orphan id "${id}" does not match the target store's session-id pattern and will be dropped on load`);
      }
    }
    mergeFlag(finalId, "pinnedAt", at, "pins", orphan);
  }

  // --- 语义位移：旧的项目级归档 → 该项目下每个会话族一条 archivedAt ----------
  for (const [key, value] of sortedEntries(recordOf(input.archives?.projects))) {
    const at = legacyTimestampToEpochMs(value?.archivedAt);
    if (at === null) {
      counts.invalidTimestampsSkipped++;
      warnings.push(`archives.projects["${key}"]: unparsable timestamp, entry skipped`);
      continue;
    }
    const roots = rootsByProject.get(key);
    if (roots === undefined || roots.size === 0) {
      counts.archiveProjectsDroppedNoFamilies++;
      warnings.push(`archives.projects["${key}"]: no visible session family to key in the new format, entry skipped`);
      continue;
    }
    for (const rootId of [...roots].sort()) mergeFlag(rootId, "archivedAt", at, "archives", false);
  }

  // --- 旧 pins.projects：键逐字照搬进 projects，root 从会话目录反查 -----------
  interface MergeProject { root: string; sources: Set<LegacySourceName> }
  const mergedProjects = new Map<string, MergeProject>();
  for (const [key, value] of sortedEntries(recordOf(input.pins?.projects))) {
    const at = legacyTimestampToEpochMs(value?.pinnedAt);
    if (at === null) {
      counts.invalidTimestampsSkipped++;
      warnings.push(`pins.projects["${key}"]: unparsable timestamp, entry skipped`);
      continue;
    }
    // pin-project 要求非空且 ≤4096 字符的 root（"__proto__" 会被上游当原型而非键）；反查不到就无法构造合法请求。
    const root = key === "__proto__" ? undefined : rootPathByKey.get(key);
    if (root === undefined || root.length === 0 || root.length > 4096) {
      counts.projectPinsDroppedNoRoot++;
      warnings.push(`pins.projects["${key}"]: root could not be resolved from the session catalogue, entry skipped`);
      continue;
    }
    if (!mergedProjects.has(key)) mergedProjects.set(key, { root, sources: new Set<LegacySourceName>(["pins"]) });
  }

  counts.mergedSessions = merged.size;
  counts.mergedProjects = mergedProjects.size;

  // --- 上限：条目数截断 + 字节预算模拟（明确报告，绝不静默） ------------------
  // 排序后逐条试装：一旦有条目被上限挤掉，其后的条目同样计入截断（确定性）。
  const sessionIdsSorted = [...merged.keys()].sort();
  const projectKeysSorted = [...mergedProjects.keys()].sort();
  const fitsSessionCount = Math.min(sessionIdsSorted.length, maxSessions);
  const fitsProjectCount = Math.min(projectKeysSorted.length, maxProjects);
  counts.truncatedByCount.sessions = sessionIdsSorted.length - fitsSessionCount;
  counts.truncatedByCount.projects = projectKeysSorted.length - fitsProjectCount;

  // 字节模拟：从空 state 出发按稳定顺序逐条应用（用上游纯规则函数），装不下
  // 的从「试装失败」那一条起计入截断。projectOrder 不生成，故
  // MAX_PROJECT_ORDER_KEYS / PROJECT_ORDER_MAX_BYTES 天然满足。
  let simulated = emptySessionUiState();
  const acceptedSessionIds: string[] = [];
  const acceptedProjectKeys: string[] = [];
  for (const id of sessionIdsSorted.slice(0, fitsSessionCount)) {
    const cell = merged.get(id)!;
    const snapshotEntry: SessionUiFlagsSnapshot = {
      id,
      pinnedAt: cell.pinnedAt ?? null,
      archivedAt: cell.archivedAt ?? null,
    };
    const next = applySessionUiStateRequest(simulated, { action: "restore", entries: [snapshotEntry] }, APPROX_NOW_MS).state;
    if (utf8.encode(JSON.stringify(next)).length <= maxBytes) {
      simulated = next;
      acceptedSessionIds.push(id);
    } else {
      counts.truncatedByBytes.sessions += 1;
    }
  }
  for (const key of projectKeysSorted.slice(0, fitsProjectCount)) {
    const entry = mergedProjects.get(key)!;
    const next = applySessionUiStateRequest(simulated, { action: "pin-project", projectKey: key, root: entry.root, pinned: true }, APPROX_NOW_MS).state;
    if (utf8.encode(JSON.stringify(next)).length <= maxBytes) {
      simulated = next;
      acceptedProjectKeys.push(key);
    } else {
      counts.truncatedByBytes.projects += 1;
    }
  }

  return {
    sessions: acceptedSessionIds.map((id) => {
      const cell = merged.get(id)!;
      const out: PlannedSessionEntry = { id, sources: [...cell.sources].sort(), orphan: cell.orphan };
      if (cell.pinnedAt !== undefined) out.pinnedAt = cell.pinnedAt;
      if (cell.archivedAt !== undefined) out.archivedAt = cell.archivedAt;
      return out;
    }),
    projects: acceptedProjectKeys.map((key) => {
      const entry = mergedProjects.get(key)!;
      return { key, root: entry.root, sources: [...entry.sources].sort() };
    }),
    counts,
    warnings,
  };
}

/** 计划 → 请求序列：只用共享模块里已有的动作构造（见头部注释的行号说明）。 */
export function planToRequests(plan: MigrationPlan): SessionUiStateRequest[] {
  const requests: SessionUiStateRequest[] = [];
  // "restore"（session-ui-state-shared.ts 第 53 行）：唯一能保住精确时间戳的动作。
  for (const chunk of chunkForSessionUiRequests(plan.sessions, MAX_SESSION_UI_IDS_PER_REQUEST)) {
    requests.push({
      action: "restore",
      entries: chunk.map((entry): SessionUiFlagsSnapshot => ({
        id: entry.id,
        pinnedAt: entry.pinnedAt ?? null,
        archivedAt: entry.archivedAt ?? null,
      })),
    });
  }
  // "pin-project"（第 54 行）：pinnedAt 会被盖上写入时刻（语义位移，见头部注释）。
  for (const project of plan.projects) {
    requests.push({ action: "pin-project", projectKey: project.key, root: project.root, pinned: true });
  }
  return requests;
}

// ---------------------------------------------------------------------------
// IO / 执行层
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  agentDir?: string;
  /** 覆盖目标文件路径；默认 getSessionUiStatePath(agentDir)。测试用它避免真实 ~/.pi/agent/。 */
  targetPath?: string;
  /** 会话目录提供者；默认动态加载 session-reader 的全量列表。测试注入假数据。 */
  listSessions?: () => Promise<readonly SessionInfo[]>;
  limits?: MigrationLimits;
  /** 改名后缀用的 UTC 毫秒戳；默认 Date.now()。测试注入以保证确定性。 */
  nowMs?: () => number;
}

export interface MigrateResult {
  action: "skipped" | "noop" | "migrated";
  reason?: string;
  error?: string;
  plan?: MigrationPlan;
  requestsExecuted: number;
  /** 成功改名出去的源文件的新名字。 */
  renamed: string[];
  warnings: string[];
}

interface SourceSide {
  path: string;
  data: Record<string, unknown> | null;
  hasContent: boolean;
  warn?: string;
}

function readLegacySource(path: string, kinds: string[]): SourceSide {
  try {
    const text = readRegularFileText(path, PROJECT_SETTINGS_MAX_BYTES);
    if (text === undefined) return { path, data: null, hasContent: false }; // 缺失：不算内容，也不警告
    const parsed = parseJsonc(text);
    if (!isPlainObject(parsed)) throw new Error("parsed to a non-object");
    // version 缺失或为 1 才认；其它版本按不可解析处理。
    if (parsed.version !== undefined && parsed.version !== 1) throw new Error(`unknown legacy store version ${String(parsed.version)}`);
    const hasContent = kinds.some((kind) => Object.keys(recordOf(parsed[kind])).length > 0);
    return { path, data: parsed, hasContent };
  } catch (error) {
    // 解析失败/非正则文件 → 那一侧原地不动、记警告；绝不清洗修复。
    return {
      path,
      data: null,
      hasContent: false,
      warn: `${path}: unreadable as a legacy store (${error instanceof Error ? error.message : String(error)}), left in place`,
    };
  }
}

/**
 * 一次性迁移入口（服务端运行）。返回值的 plan.counts 里带全部截断/跳过计数；
 * 「不许静默截断」意味着调用方必须自己看这些数字。
 */
export async function migrateLegacyUiState(options: MigrateOptions = {}): Promise<MigrateResult> {
  const agentDir = options.agentDir ?? getAgentDir();
  const targetPath = options.targetPath ?? getSessionUiStatePath(agentDir);
  const warnings: string[] = [];
  const renamed: string[] = [];

  // 安全规则：只在目标不存在时执行，绝不覆盖已有目标（这也是幂等的保证）。
  if (existsSync(targetPath)) {
    return { action: "skipped", reason: "target-exists", requestsExecuted: 0, renamed, warnings };
  }

  const pinsSide = readLegacySource(join(agentDir, "pi-web", "pins.json"), ["sessions", "projects"]);
  const archivesSide = readLegacySource(join(agentDir, "pi-web", "archives.json"), ["projects"]);
  for (const side of [pinsSide, archivesSide]) if (side.warn) warnings.push(side.warn);

  // 两个源都是空 → no-op（连写盘都不发生）。
  if (!pinsSide.hasContent && !archivesSide.hasContent) {
    return { action: "noop", requestsExecuted: 0, renamed, warnings };
  }

  let sessions: readonly SessionInfo[];
  if (options.listSessions) {
    sessions = await options.listSessions();
  } else {
    // 默认走真实会话目录；动态导入避免把重依赖拉进纯逻辑测试路径。
    const reader = await import("./session-reader");
    sessions = await reader.listAllSessions();
  }

  const plan = planLegacyMigration({
    pins: pinsSide.data as LegacyPinsInput | null,
    archives: archivesSide.data as LegacyArchivesInput | null,
    sessions,
    limits: options.limits,
  });
  warnings.push(...plan.warnings);
  const result: MigrateResult = { action: "migrated", plan, requestsExecuted: 0, renamed, warnings };

  const requests = planToRequests(plan);
  if (requests.length === 0) return result; // 有内容但全部被跳过/计数：不动笔、不改名

  for (const request of requests) {
    try {
      await updateSessionUiState(request, targetPath); // 复用上游写入层（锁 + 原子写 + revision bump）
      result.requestsExecuted++;
    } catch (error) {
      // 任何一步失败都不改名。
      result.error = error instanceof Error ? error.message : String(error);
      return result;
    }
  }

  // 发生了截断丢条目就不改名：源文件留在原地等人工复核（计划本身已如实报数）。
  const truncatedTotal =
    plan.counts.truncatedByCount.sessions + plan.counts.truncatedByCount.projects +
    plan.counts.truncatedByBytes.sessions + plan.counts.truncatedByBytes.projects;
  if (truncatedTotal > 0) return result;

  // 成功迁移后，把对最终写入有贡献的源各自改名为 <原名>.migrated-<UTC毫秒>
  // （不是删除！留审计痕迹、可回退）；没贡献的源原地不动。
  const stamp = (options.nowMs ?? Date.now)();
  for (const [side, name] of [[pinsSide, "pins"], [archivesSide, "archives"]] as const) {
    if (!side.hasContent) continue;
    const contributed = [...mergedSources(plan)].includes(name);
    if (!contributed) continue;
    const target = `${side.path}.migrated-${stamp}`;
    renameSync(side.path, target);
    renamed.push(target);
  }
  return result;
}

function mergedSources(plan: MigrationPlan): Set<LegacySourceName> {
  const set = new Set<LegacySourceName>();
  for (const entry of plan.sessions) for (const source of entry.sources) set.add(source);
  for (const entry of plan.projects) for (const source of entry.sources) set.add(source);
  return set;
}

/** 类型引用保活：这些共享类型在运行时不需要，仅为文档完整。 */
void (null as unknown as SessionUiProjectState | null);
