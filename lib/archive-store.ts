// [archive-fork] Server-side archive store.
//
// Archives are a view flag (not a file move). Session jsonl files stay where
// pi put them; this file only records which project identity keys are hidden
// from the sidebar. Same storage rules as pins.json: private state under
// getAgentDir()/pi-web/, lock + atomic write, invisible to the pi CLI.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  MAX_ARCHIVED_PROJECTS,
  archivesPayloadOf,
  pruneArchiveMap,
  type ArchiveMap,
  type ArchivesPayload,
} from "./archive-order";

export const ARCHIVE_STORE_VERSION = 1;

export interface ArchiveStoreShape {
  version: number;
  projects: ArchiveMap;
}

export function getArchiveStorePath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "pi-web", "archives.json");
}

function emptyStore(): ArchiveStoreShape {
  return { version: ARCHIVE_STORE_VERSION, projects: {} };
}

function mapOf(input: unknown): ArchiveMap {
  if (!input || typeof input !== "object") return {};
  const next: ArchiveMap = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key) continue;
    const record = value && typeof value === "object"
      ? (value as { archivedAt?: unknown })
      : null;
    const archivedAt = typeof record?.archivedAt === "string" ? record.archivedAt : "";
    next[key] = { archivedAt };
  }
  return next;
}

export function parseArchiveStoreText(text: string): ArchiveStoreShape {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object") return emptyStore();
    const value = raw as Partial<ArchiveStoreShape>;
    return {
      version: typeof value.version === "number" ? value.version : ARCHIVE_STORE_VERSION,
      projects: mapOf(value.projects),
    };
  } catch {
    return emptyStore();
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  store: ArchiveStoreShape;
}

const storeCache = new Map<string, CacheEntry>();

function readFingerprint(target: string): { mtimeMs: number; size: number } | null {
  try {
    const stats = statSync(target);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

function readStoreUncached(target: string): ArchiveStoreShape {
  try {
    return parseArchiveStoreText(readFileSync(target, "utf8"));
  } catch {
    return emptyStore();
  }
}

export function readArchiveStore(agentDir: string = getAgentDir()): ArchiveStoreShape {
  const target = getArchiveStorePath(agentDir);
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

export function getArchivesPayload(agentDir: string = getAgentDir()): ArchivesPayload {
  return archivesPayloadOf(readArchiveStore(agentDir).projects);
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

async function mutateArchiveStore(
  agentDir: string,
  mutate: (store: ArchiveStoreShape) => { store: ArchiveStoreShape; changed: boolean },
): Promise<void> {
  const target = getArchiveStorePath(agentDir);
  ensureStoreFile(target);

  const release = await lockfile.lock(target, { realpath: false, retries: 10 });
  try {
    const next = mutate(readStoreUncached(target));
    if (!next.changed) return;
    writePrivateFileAtomicSync(target, JSON.stringify(next.store, null, 2));
    try {
      chmodSync(target, 0o600);
    } catch {
      // POSIX-only hardening.
    }
    const fingerprint = readFingerprint(target);
    if (fingerprint) storeCache.set(target, { ...fingerprint, store: next.store });
    else storeCache.delete(target);
  } finally {
    await release();
  }
}

export async function setProjectArchived(options: {
  key: string;
  archived: boolean;
  agentDir?: string;
}): Promise<ArchivesPayload> {
  const { key, archived } = options;
  const agentDir = options.agentDir ?? getAgentDir();

  await mutateArchiveStore(agentDir, (store) => {
    const has = Object.prototype.hasOwnProperty.call(store.projects, key);
    if (archived === has) return { store, changed: false };

    const next: ArchiveMap = { ...store.projects };
    if (archived) {
      if (Object.keys(next).length >= MAX_ARCHIVED_PROJECTS) {
        throw new Error(`Cannot archive more than ${MAX_ARCHIVED_PROJECTS} projects`);
      }
      next[key] = { archivedAt: new Date().toISOString() };
    } else {
      delete next[key];
    }
    return { store: { ...store, projects: next }, changed: true };
  });

  return getArchivesPayload(agentDir);
}

/**
 * Drop archive rows whose project no longer has any sessions.
 * Never throws: housekeeping must not take the session list down.
 */
export async function pruneArchives(options: {
  projectKeys: Iterable<string>;
  agentDir?: string;
}): Promise<boolean> {
  const agentDir = options.agentDir ?? getAgentDir();
  if (!existsSync(getArchiveStorePath(agentDir))) return false;

  const knownProjects = new Set(options.projectKeys);
  const cached = pruneArchiveMap(readArchiveStore(agentDir).projects, knownProjects);
  if (cached.removed === 0) return false;

  try {
    await mutateArchiveStore(agentDir, (store) => {
      const projects = pruneArchiveMap(store.projects, knownProjects);
      if (projects.removed === 0) return { store, changed: false };
      return { store: { ...store, projects: projects.map }, changed: true };
    });
    return true;
  } catch {
    return false;
  }
}

export function clearArchiveStoreCacheForTests(): void {
  storeCache.clear();
}
