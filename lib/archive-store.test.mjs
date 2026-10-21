import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { MAX_ARCHIVED_PROJECTS } = await createJiti(import.meta.url).import("./archive-order.ts");
const {
  ARCHIVE_STORE_VERSION,
  clearArchiveStoreCacheForTests,
  getArchiveStorePath,
  getArchivesPayload,
  parseArchiveStoreText,
  pruneArchives,
  readArchiveStore,
  setProjectArchived,
} = await createJiti(import.meta.url).import("./archive-store.ts");

function freshAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-archives-"));
  clearArchiveStoreCacheForTests();
  return dir;
}

test("the store lives under a pi-web subdirectory of the agent dir", () => {
  const path = getArchiveStorePath("/tmp/agent");
  assert.equal(path, join("/tmp/agent", "pi-web", "archives.json"));
  for (const reserved of ["settings.json", "auth.json", "models.json", "sessions"]) {
    assert.ok(!path.endsWith(reserved));
  }
});

test("a missing store reads as no archives without creating anything", () => {
  const agentDir = freshAgentDir();
  assert.deepEqual(getArchivesPayload(agentDir), { projects: [] });
  assert.equal(readArchiveStore(agentDir).version, ARCHIVE_STORE_VERSION);
});

test("archiving a project persists it and survives a cache reset", async () => {
  const agentDir = freshAgentDir();
  const payload = await setProjectArchived({ key: "proj-a", archived: true, agentDir });
  assert.deepEqual(payload, { projects: ["proj-a"] });

  const stored = JSON.parse(readFileSync(getArchiveStorePath(agentDir), "utf8"));
  assert.equal(stored.version, ARCHIVE_STORE_VERSION);
  assert.equal(typeof stored.projects["proj-a"].archivedAt, "string");

  clearArchiveStoreCacheForTests();
  assert.deepEqual(getArchivesPayload(agentDir), { projects: ["proj-a"] });
});

test("archiving is idempotent and unarchiving removes only that key", async () => {
  const agentDir = freshAgentDir();
  await setProjectArchived({ key: "a", archived: true, agentDir });
  await setProjectArchived({ key: "b", archived: true, agentDir });
  await setProjectArchived({ key: "a", archived: true, agentDir });
  assert.deepEqual(getArchivesPayload(agentDir).projects, ["a", "b"]);

  await setProjectArchived({ key: "a", archived: false, agentDir });
  assert.deepEqual(getArchivesPayload(agentDir).projects, ["b"]);
});

test("unarchiving an unknown key does not rewrite the store", async () => {
  const agentDir = freshAgentDir();
  await setProjectArchived({ key: "a", archived: true, agentDir });
  const before = readFileSync(getArchiveStorePath(agentDir), "utf8");
  await setProjectArchived({ key: "ghost", archived: false, agentDir });
  assert.equal(readFileSync(getArchiveStorePath(agentDir), "utf8"), before);
});

test("pruneArchives drops rows for empty projects", async () => {
  const agentDir = freshAgentDir();
  await setProjectArchived({ key: "alive", archived: true, agentDir });
  await setProjectArchived({ key: "gone", archived: true, agentDir });

  const changed = await pruneArchives({ projectKeys: ["alive"], agentDir });
  assert.equal(changed, true);
  assert.deepEqual(getArchivesPayload(agentDir), { projects: ["alive"] });

  const before = readFileSync(getArchiveStorePath(agentDir), "utf8");
  assert.equal(await pruneArchives({ projectKeys: ["alive"], agentDir }), false);
  assert.equal(readFileSync(getArchiveStorePath(agentDir), "utf8"), before);
});

test("pruneArchives is a no-op when the store file does not exist", async () => {
  const agentDir = freshAgentDir();
  assert.equal(await pruneArchives({ projectKeys: [], agentDir }), false);
});

test("a corrupt store file degrades to no archives", () => {
  const agentDir = freshAgentDir();
  mkdirSync(join(agentDir, "pi-web"), { recursive: true });
  writeFileSync(getArchiveStorePath(agentDir), "{ not json", "utf8");
  clearArchiveStoreCacheForTests();
  assert.deepEqual(getArchivesPayload(agentDir), { projects: [] });
});

test("store parsing tolerates legacy and malformed shapes", () => {
  assert.deepEqual(parseArchiveStoreText("[]"), { version: ARCHIVE_STORE_VERSION, projects: {} });
  assert.deepEqual(parseArchiveStoreText('{"projects":null}'), {
    version: ARCHIVE_STORE_VERSION,
    projects: {},
  });
  assert.deepEqual(parseArchiveStoreText('{"projects":{"a":"oops"}}').projects, { a: { archivedAt: "" } });
});

test("the archive cap is enforced", async () => {
  const agentDir = freshAgentDir();
  mkdirSync(join(agentDir, "pi-web"), { recursive: true });
  const full = {};
  for (let index = 0; index < MAX_ARCHIVED_PROJECTS; index += 1) {
    full[`p-${index}`] = { archivedAt: "" };
  }
  writeFileSync(getArchiveStorePath(agentDir), JSON.stringify({
    version: ARCHIVE_STORE_VERSION,
    projects: full,
  }), "utf8");
  clearArchiveStoreCacheForTests();

  await assert.rejects(
    () => setProjectArchived({ key: "overflow", archived: true, agentDir }),
    /Cannot archive more than/,
  );
  assert.equal(getArchivesPayload(agentDir).projects.length, MAX_ARCHIVED_PROJECTS);
});
