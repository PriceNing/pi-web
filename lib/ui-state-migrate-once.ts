// 一次性把旧存储导入上游统一 UI state 的接线。
//
// 背景：v0.11.0 起上游把置顶/归档/项目顺序收进一份统一状态
// （~/.pi/agent/pi-web-session-state.json）。本 fork 早于那版用的是两份旧文件
// （~/.pi/agent/pi-web/pins.json、archives.json）。升级到新版的机器上，那两份旧
// 文件里的置顶与归档就再也看不见了 —— 除非有人跑一次导入。
//
// 这里把 lib/ui-state-migrate.ts 的导入器接到产品路径上：
//
//   - 只在统一状态**还不存在**时执行（导入器自己的守卫），所以是幂等的；
//   - 已经有状态 = 已经迁移过（或用户本来就没旧数据）→ 立刻返回，零开销；
//   - 导入失败**不抛**：迁移是尽力而为的增强，失败不能拖垮读取置顶/归档的请求。
//
// 为什么放在独立模块里：这个文件属于 fork，不属于上游，改它不会和上游同步冲突。

import { migrateLegacyUiState } from "./ui-state-migrate";

/** 一次导入的结果摘要，用于日志与排查。 */
export interface MigrationOutcome {
  /** 是否真的执行了导入（false = 跳过或无事可做）。 */
  ran: boolean;
  /** 导入器的动作：skipped / noop / migrated。 */
  action?: string;
  /** 导入器给出的警告（例如旧文件无法解析而原地保留）。 */
  warnings: string[];
  /** 导入器报出的错误（导入失败，不影响主流程）。 */
  error?: string;
  /** 成功改名出去的旧文件名（留审计痕迹）。 */
  renamed: string[];
}

/** 进程内记住「已经试过一次」，避免每个请求都去 stat 旧文件。 */
let attempted = false;
let lastOutcome: MigrationOutcome = { ran: false, warnings: [], renamed: [] };

/**
 * 尝试一次性导入旧存储。永不抛异常。
 *
 * @param force 即使本进程已经试过也再试一次（供 CLI / 运维手动触发用）。
 */
export async function migrateLegacyUiStateOnce(force = false): Promise<MigrationOutcome> {
  if (attempted && !force) return lastOutcome;
  attempted = true;

  try {
    const result = await migrateLegacyUiState();
    lastOutcome = {
      ran: result.action === "migrated",
      action: result.action,
      warnings: result.warnings,
      error: result.error,
      renamed: result.renamed,
    };
    if (result.action === "migrated") {
      console.log(
        `[ui-state] 已把旧置顶/归档导入统一状态（${result.requestsExecuted} 项）${
          result.renamed.length > 0 ? `，旧文件改名保留：${result.renamed.join(", ")}` : ""
        }`,
      );
    }
    for (const warning of result.warnings) {
      console.warn(`[ui-state] 旧存储导入警告：${warning}`);
    }
    if (result.error) {
      console.error(`[ui-state] 旧存储导入失败（不影响现有功能）：${result.error}`);
    }
  } catch (error) {
    lastOutcome = {
      ran: false,
      warnings: [],
      error: error instanceof Error ? error.message : String(error),
      renamed: [],
    };
    console.error(`[ui-state] 旧存储导入异常（不影响现有功能）：${lastOutcome.error}`);
  }

  return lastOutcome;
}

/** 只看上次结果，不触发导入（供状态展示用）。 */
export function lastMigrationOutcome(): MigrationOutcome {
  return lastOutcome;
}
