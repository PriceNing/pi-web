import { NextResponse } from "next/server";
import { attachSessionProjectInfo, listAllSessions, mergeSessionLists } from "@/lib/session-reader";
import { getRpcSessionInfos } from "@/lib/rpc-manager";
import { readSessionUiState } from "@/lib/session-ui-state";
import { workspaceKeyOf } from "@/lib/workspace-memory";

// [archive-fork] Read-only view of the unified UI state (`lib/session-ui-state.ts`).
//
// The retired fork stores (`pi-web/pins.json`, `archives.json`) are no longer the
// truth source, so this endpoint no longer writes: unarchive goes through the
// sidebar's own writer, `POST /api/sessions/ui-state`. What stays here is the
// render-friendly aggregation the settings page needs, and the discipline that
// every identity is computed HERE from `workspaceKeyOf`; the client never builds an
// identity out of a raw path (display paths are display only).

export const dynamic = "force-dynamic";

/** One archived session FAMILY (the flag lives on its family root row). */
export interface ArchivedFamilyEntry {
  /** Family root session id — the key the unified store uses. */
  id: string;
  name?: string;
  firstMessage?: string;
  messageCount: number;
  modified: string;
  archivedAt: number;
}

export interface ArchivedProjectEntry {
  /** Server-computed project identity (`workspaceKeyOf`). Never a client guess. */
  key: string;
  /** Original path, for display and nothing else. */
  root: string;
  families: ArchivedFamilyEntry[];
}

export interface ArchivesViewResponse {
  projects: ArchivedProjectEntry[];
}

/** Newest activity first, mirroring how the sidebar orders projects and rows. */
function byRecentActivity(a: ArchivedProjectEntry, b: ArchivedProjectEntry): number {
  const latestOf = (project: ArchivedProjectEntry) =>
    project.families.reduce((latest, family) => Math.max(latest, Date.parse(family.modified) || 0), 0);
  return latestOf(b) - latestOf(a);
}

// GET /api/archives - archived session families grouped by server-computed project.
export async function GET() {
  try {
    const state = readSessionUiState();
    const archivedAtById = new Map<string, number>();
    for (const [id, entry] of Object.entries(state.sessions)) {
      if (typeof entry.archivedAt === "number") archivedAtById.set(id, entry.archivedAt);
    }

    const [persisted, runtime] = await Promise.all([
      listAllSessions(),
      attachSessionProjectInfo(getRpcSessionInfos({ includeTransient: true })),
    ]);
    const sessions = mergeSessionLists(persisted, runtime);

    const projects = new Map<string, ArchivedProjectEntry>();
    for (const session of sessions) {
      // Only family roots carry a flag; a subagent row never owns one.
      if (session.relation?.kind === "subagent") continue;
      const archivedAt = archivedAtById.get(session.id);
      if (archivedAt === undefined) continue;
      // The identity is computed here, from the same function every other server
      // call site uses; the client only ever echoes it back.
      const key = workspaceKeyOf(session);
      if (!key) continue;
      const root = session.projectRoot ?? session.cwd;
      let project = projects.get(key);
      if (!project) {
        project = { key, root, families: [] };
        projects.set(key, project);
      }
      project.families.push({
        id: session.id,
        ...(session.name ? { name: session.name } : {}),
        ...(session.firstMessage ? { firstMessage: session.firstMessage } : {}),
        messageCount: session.messageCount,
        modified: session.modified,
        archivedAt,
      });
    }

    const view: ArchivesViewResponse = {
      projects: [...projects.values()]
        .sort(byRecentActivity)
        .map((project) => ({
          ...project,
          families: [...project.families].sort((a, b) => b.archivedAt - a.archivedAt),
        })),
    };
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
