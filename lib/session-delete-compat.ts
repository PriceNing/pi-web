// [archive-fork] 我们自己的删除入口，住在**新文件**里而不是上游的
// lib/session-delete.ts 旁边。
//
// 为什么单独一个文件：上游在 v0.12 自己写了同名同路径的 lib/session-delete.ts
// （批量删除、级联、重挂父、关 wrapper、删完 forget 统一 UI state）。我们只剩
// 归档页那一条调用方需要「删一条、没了就报 404」的语义，于是把这一层薄包装
// 放在自己的文件里，让上游那份文件与我们**逐字相同**——文件相同就不会再冲突，
// 这是 2026-10 那几轮同步反复断更的根本教训。
//
// 规则（见 docs/FORK.md §12）：**不改上游的文件**。需要扩展时新建文件、
// 在调用点接线；实在必须改的，写进 scripts/merge-upstream.mjs 的策略表，
// 由合并脚本按既定方向自动解，不再靠人工每次临场判断。

import { deleteSessions } from "@/lib/session-delete";

export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super("Session not found");
    this.name = "SessionNotFoundError";
  }
}

/**
 * 删一条会话（连同它下面的 subagent），没了就抛 SessionNotFoundError。
 * 实现只有上游那一份，这里只做「单条 + 404」这层适配。
 */
export async function deleteSessionById(id: string): Promise<{ deletedSessionIds: string[] }> {
  const result = await deleteSessions([id]);
  if (result.missing.length > 0) throw new SessionNotFoundError(id);
  return { deletedSessionIds: result.deleted };
}
