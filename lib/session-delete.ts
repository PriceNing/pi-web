import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import {
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
  mergeSessionLists,
  readSessionHeader,
  resolveSessionPath,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { abortSubagent, getRpcSession, getRpcSessionInfos } from "@/lib/rpc-manager";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, SUBAGENT_META_TYPE } from "@/lib/subagents";

export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super("Session not found");
    this.name = "SessionNotFoundError";
  }
}

/**
 * Delete one persisted session and every subagent below it.
 *
 * Lifted out of the DELETE route so a project-level bulk delete can reuse the
 * same cascade / re-parent / shutdown behaviour instead of copying it.
 */
export async function deleteSessionById(id: string): Promise<{ deletedSessionIds: string[] }> {
  const filePath = await resolveSessionPath(id);
  if (!filePath) throw new SessionNotFoundError(id);

  let parentSessionPath: string | undefined;
  try {
    parentSessionPath = readSessionHeader(filePath)?.parentSession;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let parentSessionId: string | undefined;
  if (parentSessionPath) {
    try {
      parentSessionId = readSessionHeader(parentSessionPath)?.id;
    } catch {
      parentSessionId = undefined;
    }
  }

  const targetPathKey = sessionPathKey(filePath);
  const dir = dirname(filePath);
  const sessions = mergeSessionLists(
    await listAllSessions({ force: true }),
    getRpcSessionInfos({ includeTransient: true }),
  );
  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (session.relation?.kind !== "subagent") continue;
    const children = childrenByParent.get(session.relation.parentSessionId) ?? [];
    children.push(session.id);
    childrenByParent.set(session.relation.parentSessionId, children);
  }
  const sessionPaths = new Map(sessions.map((session) => [session.id, session.path]));
  try {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
      const childPath = join(dir, file);
      if (sessionPathKey(childPath) === targetPathKey) continue;
      try {
        const lines = readFileSync(childPath, "utf8").split("\n");
        const header = JSON.parse(lines[0]) as { type?: string; id?: string };
        if (header.type !== "session" || typeof header.id !== "string") continue;
        const entries = lines.slice(1).flatMap((line) => {
          try { return [JSON.parse(line) as SessionEntry]; } catch { return []; }
        });
        const subagent = readSubagentRun(entries, header.id, childPath);
        if (!subagent) continue;
        const children = childrenByParent.get(subagent.parentSessionId) ?? [];
        children.push(header.id);
        childrenByParent.set(subagent.parentSessionId, children);
        sessionPaths.set(header.id, childPath);
      } catch { /* skip malformed or concurrently removed sessions */ }
    }
  } catch { /* skip if dir unreadable */ }

  const deletedSessionIds = new Set<string>([id]);
  const pending = [id];
  while (pending.length > 0) {
    const parentId = pending.pop()!;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (deletedSessionIds.has(childId)) continue;
      deletedSessionIds.add(childId);
      pending.push(childId);
    }
  }
  const deletedPaths = new Map<string, string>([[id, filePath]]);
  for (const deletedId of deletedSessionIds) {
    const sessionPath = sessionPaths.get(deletedId);
    if (sessionPath) deletedPaths.set(deletedId, sessionPath);
  }
  for (const deletedId of deletedSessionIds) {
    if (deletedPaths.has(deletedId)) continue;
    const runtimePath = getRpcSession(deletedId)?.sessionFile;
    if (runtimePath) deletedPaths.set(deletedId, runtimePath);
    else {
      const resolvedPath = await resolveSessionPath(deletedId);
      if (resolvedPath) deletedPaths.set(deletedId, resolvedPath);
    }
  }
  const deletedPathKeys = new Set([...deletedPaths.values()].map((path) => sessionPathKey(path)));

  try {
    const files = readdirSync(dir).filter(
      (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
    );
    for (const file of files) {
      const childPath = join(dir, file);
      if (deletedPathKeys.has(sessionPathKey(childPath))) continue;
      try {
        const content = readFileSync(childPath, "utf8");
        const lines = content.split("\n");
        const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
        if (
          header.type === "session"
          && header.parentSession
          && sessionPathKey(header.parentSession) === targetPathKey
        ) {
          header.parentSession = parentSessionPath;
          lines[0] = JSON.stringify(header);
          if (parentSessionPath && parentSessionId) {
            for (let index = 1; index < lines.length; index += 1) {
              let entry: { type?: string; customType?: string; data?: unknown };
              try {
                entry = JSON.parse(lines[index]);
              } catch {
                continue;
              }
              if (
                entry.type !== "custom"
                || entry.customType !== SUBAGENT_META_TYPE
                || typeof entry.data !== "object"
                || entry.data === null
                || Array.isArray(entry.data)
              ) continue;
              entry.data = {
                ...entry.data,
                parentSessionId,
                parentSessionPath,
              };
              lines[index] = JSON.stringify(entry);
              break;
            }
          }
          writeFileSync(childPath, lines.join("\n"));
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* skip if dir unreadable */ }

  for (const deletedId of [...deletedSessionIds].reverse()) {
    if (deletedId === id) continue;
    try { await abortSubagent(deletedId); } catch { /* idle or completed */ }
    await getRpcSession(deletedId)?.shutdown();
  }
  try { await abortSubagent(id); } catch { /* ordinary session */ }
  await getRpcSession(id)?.shutdown();
  for (const [deletedId, deletedPath] of deletedPaths) {
    try {
      unlinkSync(deletedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    invalidateSessionPathCache(deletedId);
  }
  invalidateSessionListCache();
  return { deletedSessionIds: [...deletedSessionIds] };
}
