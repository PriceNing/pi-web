import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  MAX_PINS_PER_KIND,
} = await createJiti(import.meta.url).import("./pin-order.ts");

const {
  PIN_STORE_VERSION,
  clearPinStoreCacheForTests,
  getPinsPayload,
  getPinStorePath,
  parsePinStoreText,
  prunePins,
  readPinStore,
  setPin,
} = await createJiti(import.meta.url).import("./pin-store.ts");

function freshAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-pins-"));
  clearPinStoreCacheForTests();
  return dir;
}

test("the store lives under a pi-web subdirectory of the agent dir", () => {
  const path = getPinStorePath("/tmp/agent");
  assert.equal(path, join("/tmp/agent", "pi-web", "pins.json"));
  // Never a name pi itself owns, so the shared config dir stays unambiguous.
  for (const reserved of ["settings.json", "auth.json", "models.json", "sessions"]) {
    assert.ok(!path.endsWith(reserved));
  }
});

test("a missing store reads as no pins without creating anything", () => {
  const agentDir = freshAgentDir();
  assert.deepEqual(getPinsPayload(agentDir), { sessions: [], projects: [] });
  assert.equal(readPinStore(agentDir).version, PIN_STORE_VERSION);
});

test("pinning a session persists it and survives a cache reset", async () => {
  const agentDir = freshAgentDir();
  const payload = await setPin({ kind: "session", key: "s-1", pinned: true, agentDir });
  assert.deepEqual(payload, { sessions: ["s-1"], projects: [] });

  const stored = JSON.parse(readFileSync(getPinStorePath(agentDir), "utf8"));
  assert.equal(stored.version, PIN_STORE_VERSION);
  assert.equal(typeof stored.sessions["s-1"].pinnedAt, "string");

  clearPinStoreCacheForTests();
  assert.deepEqual(getPinsPayload(agentDir), { sessions: ["s-1"], projects: [] });
});

test("pinning is idempotent and unpinning removes only that key", async () => {
  const agentDir = freshAgentDir();
  await setPin({ kind: "session", key: "s-1", pinned: true, agentDir });
  await setPin({ kind: "session", key: "s-2", pinned: true, agentDir });
  await setPin({ kind: "session", key: "s-1", pinned: true, agentDir });
  assert.deepEqual(getPinsPayload(agentDir).sessions, ["s-1", "s-2"]);

  await setPin({ kind: "session", key: "s-1", pinned: false, agentDir });
  assert.deepEqual(getPinsPayload(agentDir).sessions, ["s-2"]);
});

test("unpinning an unknown key does not rewrite the store", async () => {
  const agentDir = freshAgentDir();
  await setPin({ kind: "session", key: "s-1", pinned: true, agentDir });
  const before = readFileSync(getPinStorePath(agentDir), "utf8");
  await setPin({ kind: "session", key: "ghost", pinned: false, agentDir });
  assert.equal(readFileSync(getPinStorePath(agentDir), "utf8"), before);
});

test("project pins are a separate namespace from session pins", async () => {
  const agentDir = freshAgentDir();
  await setPin({ kind: "project", key: "same", pinned: true, agentDir });
  await setPin({ kind: "session", key: "same", pinned: true, agentDir });
  const payload = getPinsPayload(agentDir);
  assert.deepEqual(payload, { sessions: ["same"], projects: ["same"] });

  await setPin({ kind: "project", key: "same", pinned: false, agentDir });
  assert.deepEqual(getPinsPayload(agentDir), { sessions: ["same"], projects: [] });
});

test("prunePins drops pins for deleted sessions and empty projects", async () => {
  const agentDir = freshAgentDir();
  await setPin({ kind: "session", key: "alive", pinned: true, agentDir });
  await setPin({ kind: "session", key: "deleted", pinned: true, agentDir });
  await setPin({ kind: "project", key: "proj-a", pinned: true, agentDir });
  await setPin({ kind: "project", key: "proj-gone", pinned: true, agentDir });

  const changed = await prunePins({
    sessionIds: ["alive"],
    projectKeys: ["proj-a"],
    agentDir,
  });
  assert.equal(changed, true);
  assert.deepEqual(getPinsPayload(agentDir), { sessions: ["alive"], projects: ["proj-a"] });

  // A second pass has nothing to remove, so it must not rewrite the file.
  const before = readFileSync(getPinStorePath(agentDir), "utf8");
  assert.equal(await prunePins({ sessionIds: ["alive"], projectKeys: ["proj-a"], agentDir }), false);
  assert.equal(readFileSync(getPinStorePath(agentDir), "utf8"), before);
});

test("prunePins is a no-op when the store file does not exist", async () => {
  const agentDir = freshAgentDir();
  assert.equal(await prunePins({ sessionIds: [], projectKeys: [], agentDir }), false);
});

test("a corrupt store file degrades to no pins", () => {
  const agentDir = freshAgentDir();
  mkdirSync(join(agentDir, "pi-web"), { recursive: true });
  writeFileSync(getPinStorePath(agentDir), "{ not json", "utf8");
  clearPinStoreCacheForTests();
  assert.deepEqual(getPinsPayload(agentDir), { sessions: [], projects: [] });
});

test("store parsing tolerates legacy and malformed shapes", () => {
  assert.deepEqual(parsePinStoreText("[]"), { version: PIN_STORE_VERSION, sessions: {}, projects: {} });
  assert.deepEqual(parsePinStoreText('{"sessions":null}'), {
    version: PIN_STORE_VERSION,
    sessions: {},
    projects: {},
  });
  // A bare string value for an entry still counts as pinned, with no timestamp.
  assert.deepEqual(parsePinStoreText('{"sessions":{"a":"oops"}}').sessions, { a: { pinnedAt: "" } });
});

test("the per-kind pin cap is enforced", async () => {
  const agentDir = freshAgentDir();
  mkdirSync(join(agentDir, "pi-web"), { recursive: true });
  const full = {};
  for (let index = 0; index < MAX_PINS_PER_KIND; index += 1) {
    full[`s-${index}`] = { pinnedAt: "" };
  }
  writeFileSync(getPinStorePath(agentDir), JSON.stringify({
    version: PIN_STORE_VERSION,
    sessions: full,
    projects: {},
  }), "utf8");
  clearPinStoreCacheForTests();

  await assert.rejects(
    () => setPin({ kind: "session", key: "overflow", pinned: true, agentDir }),
    /Cannot pin more than/,
  );
  // Existing state is untouched by the rejected write.
  assert.equal(getPinsPayload(agentDir).sessions.length, MAX_PINS_PER_KIND);
});
