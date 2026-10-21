// [archive-fork] Shared, dependency-free helpers for archived projects.
//
// Browser-safe: no fs/path/os/Next imports. Archive is a view flag keyed by
// the server-computed project identity; session files are never moved.

export interface ArchiveEntry {
  archivedAt: string;
}

export type ArchiveMap = Record<string, ArchiveEntry>;

export interface ArchivesPayload {
  projects: string[];
}

export const MAX_ARCHIVED_PROJECTS = 500;
export const MAX_ARCHIVE_KEY_LENGTH = 512;

export function emptyArchivesPayload(): ArchivesPayload {
  return { projects: [] };
}

export function archiveKeysOf(map: ArchiveMap): string[] {
  return Object.keys(map).sort();
}

export function archivesPayloadOf(projects: ArchiveMap): ArchivesPayload {
  return { projects: archiveKeysOf(projects) };
}

export function archiveSetOf(payload: ArchivesPayload): ReadonlySet<string> {
  return new Set(payload.projects);
}

export function parseArchivesPayload(raw: unknown): ArchivesPayload {
  if (!raw || typeof raw !== "object") return emptyArchivesPayload();
  const value = raw as { projects?: unknown; archives?: unknown };
  return { projects: stringKeyList(value.projects ?? value.archives) };
}

function stringKeyList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const key = item.trim();
    if (key) seen.add(key);
  }
  return [...seen].sort();
}

export function normalizeArchiveKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > MAX_ARCHIVE_KEY_LENGTH) return null;
  return trimmed;
}

export function archiveSetsDiffer(next: ReadonlySet<string>, previous: ReadonlySet<string>): boolean {
  if (next.size !== previous.size) return true;
  for (const key of next) {
    if (!previous.has(key)) return true;
  }
  return false;
}

export function pruneArchiveMap(
  map: ArchiveMap,
  knownKeys: ReadonlySet<string>,
): { map: ArchiveMap; removed: number } {
  let removed = 0;
  const next: ArchiveMap = {};
  for (const [key, entry] of Object.entries(map)) {
    if (knownKeys.has(key)) next[key] = entry;
    else removed += 1;
  }
  return removed > 0 ? { map: next, removed } : { map, removed: 0 };
}
