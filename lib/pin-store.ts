// [pin-fork] Server-side pin store.
//
// Pins are stored on the server (not in browser storage) so that every device
// reaching this pi-web instance sees the same pinned projects and sessions.
//
// Location follows the existing pi-web precedent for private state inside the
// shared pi config directory (lib/session-list-scanner.ts keeps
// `pi-web-session-index.json` under getAgentDir()). Everything lives under a
// `pi-web/` subdirectory so pi's own config files are never adjacent to, or
// overwritten by, pi-web-only state. pi reads named paths out of the agent
// directory and does not enumerate unknown entries, so this file is invisible
// to the CLI while still travelling with agentDir (PI_CODING_AGENT_DIR).
//
// Session files are never modified: pins are purely additive metadata, and
// entries for deleted sessions or projects are pruned lazily on read.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  MAX_PINS_PER_KIND,
  pinsPayloadOf,
  prunePinMap,
  type PinKind,
  type PinMap,
  type PinsPayload,
} from "./pin-order";

export const PIN_STORE_VERSION = 1;

export interface PinStoreShape {
  version: number;
  sessions: PinMap;
  projects: PinMap;
}

/** Path of the pin store inside the (optionally overridden) agent directory. */
export function getPinStorePath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "pi-web", "pins.json");
}

function emptyStore(): PinStoreShape {
  return { version: PIN_STORE_VERSION, sessions: {}, projects: {} };
}

function mapOf(input: unknown): PinMap {
  if (!input || typeof input !== "object") return {};
  const next: PinMap = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key) continue;
    const record = value && typeof value === "object"
      ? (value as { pinnedAt?: unknown })
      : null;
    const pinnedAt = typeof record?.pinnedAt === "string" ? record.pinnedAt : "";
    next[key] = { pinnedAt };
  }
  return next;
}

/**
 * Parse store text defensively: an unreadable or half-written file must not
 * break the session list, so anything unexpected degrades to "no pins".
 */
export function parsePinStoreText(text: string): PinStoreShape {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object") return emptyStore();
    const value = raw as Partial<PinStoreShape>;
    return {
      version: typeof value.version === "number" ? value.version : PIN_STORE_VERSION,
      sessions: mapOf(value.sessions),
      projects: mapOf(value.projects),
    };
  } catch {
    return emptyStore();
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  store: PinStoreShape;
}

// Keyed by absolute path so separate agent directories (tests, overrides) never
// share an entry. Invalidated by the file fingerprint.
const storeCache = new Map<string, CacheEntry>();

function readFingerprint(target: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = statSync(target);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

function readStoreUncached(target: string): PinStoreShape {
  try {
    return parsePinStoreText(readFileSync(target, "utf8"));
  } catch {
    return emptyStore();
  }
}

/** Current store, re-read from disk only when the file fingerprint changed. */
export function readPinStore(agentDir: string = getAgentDir()): PinStoreShape {
  const target = getPinStorePath(agentDir);
  const fingerprint = readFingerprint(target);
  if (!fingerprint) return emptyStore();

  const cached = storeCache.get(target);
  if (cached
    && cached.mtimeMs === fingerprint.mtimeMs
    && cached.size === fingerprint.size) {
    return cached.store;
  }

  const store = readStoreUncached(target);
  storeCache.set(target, { ...fingerprint, store });
  return store;
}

export function getPinsPayload(agentDir: string = getAgentDir()): PinsPayload {
  const store = readPinStore(agentDir);
  return pinsPayloadOf(store.sessions, store.projects);
}

function ensureStoreFile(target: string): void {
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(target, "{}", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/**
 * Read-modify-write under a lock, so two devices pinning at the same moment
 * cannot clobber each other's entry. The mutator reports `false` when nothing
 * changed, which keeps the common no-op path free of disk writes.
 */
async function mutatePinStore(
  agentDir: string,
  mutate: (store: PinStoreShape) => { store: PinStoreShape; changed: boolean },
): Promise<void> {
  const target = getPinStorePath(agentDir);
  ensureStoreFile(target);

  const release = await lockfile.lock(target, { realpath: false, retries: 10 });
  try {
    const next = mutate(readStoreUncached(target));
    if (!next.changed) return;
    writePrivateFileAtomicSync(target, JSON.stringify(next.store, null, 2));
    try {
      chmodSync(target, 0o600);
    } catch {
      // POSIX-only hardening; the atomic write already used a 0600 temp file.
    }
    const fingerprint = readFingerprint(target);
    if (fingerprint) storeCache.set(target, { ...fingerprint, store: next.store });
    else storeCache.delete(target);
  } finally {
    await release();
  }
}

/**
 * Pin or unpin one key. Returns the resulting payload so callers adopt the
 * authoritative state instead of trusting their optimistic guess.
 */
export async function setPin(options: {
  kind: PinKind;
  key: string;
  pinned: boolean;
  agentDir?: string;
}): Promise<PinsPayload> {
  const { kind, key, pinned } = options;
  const agentDir = options.agentDir ?? getAgentDir();

  await mutatePinStore(agentDir, (store) => {
    const current = kind === "session" ? store.sessions : store.projects;
    const has = Object.prototype.hasOwnProperty.call(current, key);
    if (pinned === has) return { store, changed: false };

    const next: PinMap = { ...current };
    if (pinned) {
      if (Object.keys(next).length >= MAX_PINS_PER_KIND) {
        throw new Error(`Cannot pin more than ${MAX_PINS_PER_KIND} ${kind}s`);
      }
      next[key] = { pinnedAt: new Date().toISOString() };
    } else {
      delete next[key];
    }
    return {
      store: kind === "session"
        ? { ...store, sessions: next }
        : { ...store, projects: next },
      changed: true,
    };
  });

  return getPinsPayload(agentDir);
}

/**
 * Remove pins whose target no longer exists. Never throws: housekeeping must
 * not turn a working session list into a 500.
 */
export async function prunePins(options: {
  sessionIds: Iterable<string>;
  projectKeys: Iterable<string>;
  agentDir?: string;
}): Promise<boolean> {
  const agentDir = options.agentDir ?? getAgentDir();
  if (!existsSync(getPinStorePath(agentDir))) return false;

  const knownSessions = new Set(options.sessionIds);
  const knownProjects = new Set(options.projectKeys);

  // Cheap pre-check against the cached copy; the locked pass re-verifies.
  const cached = readPinStore(agentDir);
  const cachedSessions = prunePinMap(cached.sessions, knownSessions);
  const cachedProjects = prunePinMap(cached.projects, knownProjects);
  if (cachedSessions.removed === 0 && cachedProjects.removed === 0) return false;

  try {
    await mutatePinStore(agentDir, (store) => {
      const sessions = prunePinMap(store.sessions, knownSessions);
      const projects = prunePinMap(store.projects, knownProjects);
      if (sessions.removed === 0 && projects.removed === 0) return { store, changed: false };
      return { store: { ...store, sessions: sessions.map, projects: projects.map }, changed: true };
    });
    return true;
  } catch {
    return false;
  }
}

/** Test helper: forget cached fingerprints without touching the filesystem. */
export function clearPinStoreCacheForTests(): void {
  storeCache.clear();
}
