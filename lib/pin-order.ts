// [pin-fork] Shared, dependency-free helpers for user-pinned projects and sessions.
//
// This module must stay importable from both the server (route handlers) and the
// browser bundle: no fs/path/os imports, no Next.js APIs. The ordering rules live
// here so the two sort seams (lib/session-family.ts and lib/project-groups.ts)
// behave identically.

/** Which kind of entity a pin refers to. */
export type PinKind = "session" | "project";

/** On-disk record. `pinnedAt` is metadata only; pinned items are ordered by activity. */
export interface PinEntry {
  pinnedAt: string;
}

export type PinMap = Record<string, PinEntry>;

/** Lookup-friendly view of the pin store used by the client. */
export interface PinSets {
  sessions: ReadonlySet<string>;
  projects: ReadonlySet<string>;
}

/** Wire format returned by every endpoint that carries pins. */
export interface PinsPayload {
  sessions: string[];
  projects: string[];
}

/** Upper bound per kind so a stray script cannot grow the store file without limit. */
export const MAX_PINS_PER_KIND = 500;

/** Longest accepted key; session ids and project identity keys are far shorter. */
export const MAX_PIN_KEY_LENGTH = 512;

export function emptyPinSets(): PinSets {
  return { sessions: new Set<string>(), projects: new Set<string>() };
}

export function emptyPinsPayload(): PinsPayload {
  return { sessions: [], projects: [] };
}

/** Sorted keys of a stored map, used to build wire payloads. */
export function pinKeysOf(map: PinMap): string[] {
  return Object.keys(map).sort();
}

export function pinsPayloadOf(sessions: PinMap, projects: PinMap): PinsPayload {
  return { sessions: pinKeysOf(sessions), projects: pinKeysOf(projects) };
}

export function pinSetsOf(payload: PinsPayload): PinSets {
  return {
    sessions: new Set(payload.sessions),
    projects: new Set(payload.projects),
  };
}

/**
 * Coerce an untrusted request/response value into a payload. Anything malformed
 * degrades to "no pins" instead of throwing, because a broken pin set must never
 * take the session list down with it.
 */
export function parsePinsPayload(raw: unknown): PinsPayload {
  if (!raw || typeof raw !== "object") return emptyPinsPayload();
  const value = raw as { sessions?: unknown; projects?: unknown };
  return {
    sessions: stringKeyList(value.sessions),
    projects: stringKeyList(value.projects),
  };
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

/** Validate and normalise one pin key coming from a client request. */
export function normalizePinKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > MAX_PIN_KEY_LENGTH) return null;
  return trimmed;
}

export function normalizePinKind(kind: unknown): PinKind | null {
  return kind === "session" || kind === "project" ? kind : null;
}

/** True when two pin sets differ; used to skip no-op state updates on every poll. */
export function pinsChanged(next: PinSets, previous: PinSets): boolean {
  return !sameKeySets(next.sessions, previous.sessions)
    || !sameKeySets(next.projects, previous.projects);
}

function sameKeySets(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) {
    if (!b.has(key)) return false;
  }
  return true;
}

/**
 * Comparator fragment: pinned items first, non-pinned after. Returns 0 when both
 * sides agree so the caller can fall through to its own activity ordering.
 */
export function comparePinnedFirst(aPinned: boolean, bPinned: boolean): number {
  if (aPinned === bPinned) return 0;
  return aPinned ? -1 : 1;
}

/** Drop keys that no longer exist; returns the number of removed entries. */
export function prunePinMap(map: PinMap, knownKeys: ReadonlySet<string>): { map: PinMap; removed: number } {
  let removed = 0;
  const next: PinMap = {};
  for (const [key, entry] of Object.entries(map)) {
    if (knownKeys.has(key)) next[key] = entry;
    else removed += 1;
  }
  return removed > 0 ? { map: next, removed } : { map, removed: 0 };
}
