import { NextResponse } from "next/server";
import { normalizeArchiveKey } from "@/lib/archive-order";
import { setProjectArchived } from "@/lib/archive-store";
import { setPin } from "@/lib/pin-store";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import { getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { sessionsForProject } from "@/lib/project-groups";
import { deleteSessionById, SessionNotFoundError } from "@/lib/session-delete";

export const dynamic = "force-dynamic";

function isDeleteConfirmation(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const word = value.trim().toLowerCase();
  return word === "confirm" || word === "确认" || word === "確認";
}

// POST /api/archives/sessions
// body: { projectKey: string, confirm?: string }
// Deletes every session whose workspace identity matches projectKey.
// Does not delete the working tree on disk.
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const payload = body as { projectKey?: unknown; confirm?: unknown };
  const projectKey = normalizeArchiveKey(payload.projectKey);
  if (!projectKey) {
    return NextResponse.json({ error: "projectKey must be a non-empty string" }, { status: 400 });
  }

  const [persisted, runtime] = await Promise.all([
    listAllSessions({ force: true }),
    attachSessionProjectInfo(getRpcSessionInfos({ includeTransient: true })),
  ]);
  const sessions = mergeSessionLists(persisted, runtime);
  const inProject = sessionsForProject(sessions, projectKey);
  const roots = inProject.filter((session) => session.relation?.kind !== "subagent");
  if (roots.length === 0) {
    return NextResponse.json({ error: "No sessions found for this project" }, { status: 404 });
  }

  const runningIds = new Set(getRunningRpcSessionIds());
  const running = inProject.filter((session) => runningIds.has(session.id));
  if (running.length > 0) {
    return NextResponse.json({
      error: "Cannot delete sessions while the project has a running agent",
      runningSessionIds: running.map((session) => session.id),
    }, { status: 409 });
  }

  if (!isDeleteConfirmation(payload.confirm)) {
    return NextResponse.json({
      error: "confirm must be confirm or 确认",
      sessionCount: roots.length,
    }, { status: 400 });
  }

  const deleted: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const remaining = new Set(roots.map((session) => session.id));
  for (const session of roots) {
    if (!remaining.has(session.id)) continue;
    try {
      const result = await deleteSessionById(session.id);
      for (const id of result.deletedSessionIds) {
        deleted.push(id);
        remaining.delete(id);
      }
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        remaining.delete(session.id);
        continue;
      }
      failed.push({
        id: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failed.length === 0) {
    try { await setPin({ kind: "project", key: projectKey, pinned: false }); } catch { /* ignore */ }
    try { await setProjectArchived({ key: projectKey, archived: false }); } catch { /* ignore */ }
  }

  return NextResponse.json({
    ok: failed.length === 0,
    deletedSessionIds: deleted,
    failed,
  }, {
    status: failed.length === 0 ? 200 : 207,
    headers: { "Cache-Control": "no-store" },
  });
}
