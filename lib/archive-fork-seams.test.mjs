import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// [archive-fork] Live seams after upstream v0.11.0's unified UI state.
//
// The fork's own two stores (`pi-web/pins.json`, `archives.json`) are retired as
// the truth source, so this file guards what actually carries the feature now: the
// read view answering off the unified store, the server-computed projectKey as the
// only identity, and the bulk delete's refusal conditions.

const agentDir = await mkdtemp(join(os.tmpdir(), "pi-web-archive-seams-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getArchivesView } = await jiti.import("../app/api/archives/route.ts");
const { POST: postBulkDelete } = await jiti.import("../app/api/archives/sessions/route.ts");
const { resetSessionUiStateCacheForTests, updateSessionUiState } = await jiti.import("./session-ui-state.ts");
const { invalidateSessionListCache, listAllSessions } = await jiti.import("./session-reader.ts");
const { workspaceKeyOf } = await jiti.import("./workspace-memory.ts");
const { projectIdentityKey } = await jiti.import("./project-identity.ts");
const { getRecentProjects } = await jiti.import("./project-groups.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

const JSON_HEADERS = { host: "localhost", "Content-Type": "application/json" };

function session(id, modified, extra = {}) {
  return {
    path: `/tmp/${id}.jsonl`,
    id,
    cwd: "/tmp/project",
    created: "2026-01-01T00:00:00.000Z",
    modified,
    messageCount: 3,
    firstMessage: id,
    ...extra,
  };
}

async function view() {
  const response = await getArchivesView();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return await response.json();
}

function postJson(body, headers = JSON_HEADERS) {
  return postBulkDelete(new Request("http://localhost/api/archives/sessions", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

/** A real on-disk family written the way pi writes it, under the agent dir's sessions/. */
function plantFamily(cwd, projectName) {
  const manager = SessionManager.create(cwd, join(agentDir, "sessions", projectName));
  manager.appendMessage({ role: "user", content: `first message of ${projectName}`, timestamp: Date.now() });
  invalidateSessionListCache();
  // What pi actually recorded is what the server must key on — read it back rather than assume.
  const header = JSON.parse(readFileSync(manager.getSessionFile(), "utf8").split("\n")[0]);
  return { id: manager.getSessionId(), file: manager.getSessionFile(), cwd: header.cwd, projectName };
}

async function identityOf(planted) {
  const rows = await listAllSessions({ force: true });
  const row = rows.find((item) => item.id === planted.id);
  assert.ok(row, `the scan must still see ${planted.file}`);
  return { key: workspaceKeyOf(row), root: row.projectRoot ?? row.cwd };
}

async function resetView() {
  await rm(join(agentDir, "sessions"), { recursive: true, force: true });
  await rm(join(agentDir, "pi-web-session-state.json"), { force: true });
  resetSessionUiStateCacheForTests();
  invalidateSessionListCache();
}

test("archived projects are omitted from the sidebar grouping", () => {
  const sessions = [
    session("s1", "2026-09-09T00:00:00.000Z", { projectRoot: "/tmp/new", projectKey: "key-new" }),
    session("s2", "2026-09-01T00:00:00.000Z", { projectRoot: "/tmp/old", projectKey: "key-old" }),
  ];
  assert.deepEqual(
    getRecentProjects(sessions).map((project) => project.key),
    ["key-new", "key-old"],
  );
  assert.deepEqual(
    getRecentProjects(sessions, undefined, new Set(["key-old"])).map((project) => project.key),
    ["key-new"],
  );
});

test("archived projects stay omitted even when they are pinned", () => {
  const sessions = [
    session("s1", "2026-09-09T00:00:00.000Z", { projectRoot: "/tmp/new", projectKey: "key-new" }),
    session("s2", "2026-09-08T00:00:00.000Z", { projectRoot: "/tmp/pin", projectKey: "key-pin" }),
  ];
  assert.deepEqual(
    getRecentProjects(sessions, new Set(["key-pin"]), new Set(["key-pin"])).map((project) => project.key),
    ["key-new"],
  );
});

test("an empty archived set is backward compatible", () => {
  const sessions = [session("a", "2026-09-01T00:00:00.000Z", { projectKey: "k" })];
  assert.equal(getRecentProjects(sessions, undefined, undefined).length, 1);
  assert.equal(getRecentProjects(sessions, undefined, new Set()).length, 1);
});

test("the read view answers off the unified store: only what is archived shows up", async (t) => {
  await resetView();
  t.after(resetView);

  const planted = plantFamily(join(agentDir, "home", "ProjA"), "proj-a");
  assert.deepEqual((await view()).projects, [], "nothing archived yet");

  await updateSessionUiState({ action: "set", ids: [planted.id], archived: true });
  const listed = await view();
  assert.equal(listed.projects.length, 1);
  assert.deepEqual(listed.projects[0].families.map((family) => family.id), [planted.id]);
  assert.equal(typeof listed.projects[0].families[0].archivedAt, "number");
  assert.ok(listed.projects[0].families[0].messageCount >= 1);
  // The row still carries its real path for display; identity and display are separate fields.
  const identity = await identityOf(planted);
  assert.equal(listed.projects[0].key, identity.key);
  assert.equal(listed.projects[0].root, identity.root);
});

test("identity is the server-computed projectKey, never a raw path handed back", async (t) => {
  await resetView();
  t.after(resetView);

  // Fork rule (§2.1): the key is the server-computed `projectKey`, never a path
  // string — so a trailing separator (and on Windows, letter case) must not reach
  // the client as part of the identity.
  const rawCwd = join(agentDir, "home", "ProjB") + (process.platform === "win32" ? "\\" : "/");
  const planted = plantFamily(rawCwd, "proj-b");
  await writeFile(join(agentDir, "home", "ProjB", "README.md"), "display path stays intact\n").catch(async () => {
    mkdirSync(join(agentDir, "home", "ProjB"), { recursive: true });
    await writeFile(join(agentDir, "home", "ProjB", "README.md"), "display path stays intact\n");
  });
  await updateSessionUiState({ action: "set", ids: [planted.id], archived: true });

  const listed = await view();
  assert.equal(listed.projects.length, 1);
  const row = listed.projects[0];
  assert.equal(row.families[0].id, planted.id);
  assert.equal(row.key, projectIdentityKey(planted.cwd), "the key comes out of the server's own canonicalization");
  // The raw path shape must not survive into the identity.
  assert.notEqual(row.key, rawCwd);
  assert.ok(!/[\\/]+$/.test(row.key), "no trailing separator in an identity");
  for (const project of listProjects(listed)) {
    assert.equal(project.key, projectIdentityKey(project.root));
  }
});

function listProjects(listed) {
  return Array.isArray(listed?.projects) ? listed.projects : [];
}

test("a flag whose session is gone renders nothing, and two families of one project group together", async (t) => {
  await resetView();
  t.after(resetView);

  const kept = plantFamily(join(agentDir, "home", "ProjC"), "proj-c");
  const removed = plantFamily(join(agentDir, "home", "ProjD"), "proj-d");
  const ghost = "ffffffff-0000-4444-8888-000000000000";
  await rm(join(agentDir, "sessions", "proj-d"), { recursive: true, force: true });
  invalidateSessionListCache();

  await updateSessionUiState({ action: "set", ids: [kept.id, removed.id, ghost], archived: true });
  const projects = listProjects(await view());
  assert.equal(projects.length, 1);
  assert.deepEqual(projects[0].families.map((family) => family.id), [kept.id]);

  // Two families under one identity stay one entry.
  const second = plantFamily(join(agentDir, "home", "ProjC"), "proj-c2");
  await updateSessionUiState({ action: "set", ids: [second.id], archived: true });
  const grouped = listProjects(await view());
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].families.map((family) => family.id).sort(), [kept.id, second.id].sort());
});

test("bulk delete refuses a bad body, an empty key, and a missing confirm word", async (t) => {
  await resetView();
  t.after(resetView);

  const planted = plantFamily(join(agentDir, "home", "ProjE"), "proj-e");
  const { key } = await identityOf(planted);

  assert.equal((await postJson("{ nope")).status, 400);
  assert.equal((await postJson({ projectKey: "", confirm: "confirm" })).status, 400);
  assert.equal((await postJson({ projectKey: "../../../etc", confirm: "confirm" })).status, 404);

  const refused = await postJson({ projectKey: key });
  assert.equal(refused.status, 400);
  const refusal = await refused.json();
  assert.match(refusal.error, /confirm/);
  assert.equal(refusal.sessionCount, 1);
});

test("bulk delete answers 409 while the project has a running agent", async (t) => {
  await resetView();
  t.after(async () => {
    globalThis.__piSessions = undefined;
    await resetView();
  });

  const planted = plantFamily(join(agentDir, "home", "ProjG"), "proj-g");
  const { key } = await identityOf(planted);
  // The registry as the route sees it: alive enough to be counted as running.
  globalThis.__piSessions = new Map([[planted.id, { sessionId: planted.id, isRunning: () => true }]]);

  const response = await postJson({ projectKey: key, confirm: "confirm" });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.deepEqual(body.runningSessionIds, [planted.id]);
});

test("bulk delete accepts each confirm word, deletes only sessions, and leaves the code folder alone", async (t) => {
  for (const word of ["confirm", "确认", "確認"]) {
    await resetView();
    const codeDir = join(agentDir, "home", `proj-${Buffer.from(word).toString("hex")}`);
    mkdirSync(codeDir, { recursive: true });
    await writeFile(join(codeDir, "README.md"), "the code folder must outlive its sessions\n");
    const planted = plantFamily(codeDir, `proj-${Buffer.from(word).toString("hex")}`);
    const { key } = await identityOf(planted);

    t.after(async () => {
      const rows = await listAllSessions({ force: true });
      assert.ok(!rows.some((row) => row.id === planted.id), `no session of ${word} may survive`);
      assert.equal(readFileSync(join(codeDir, "README.md"), "utf8").includes("code folder"), true);
    });

    const response = await postJson({ projectKey: key, confirm: word });
    assert.equal(response.status, 200, word);
    const result = await response.json();
    assert.equal(result.ok, true, word);
    assert.deepEqual(result.failed, [], word);
    assert.deepEqual(result.deletedSessionIds, [planted.id], word);
  }
});

test("a bulk delete takes the subagents under a family with it (the shared cascade stays in force)", async (t) => {
  await resetView();
  t.after(resetView);

  const parentId = "cascade-parent";
  const childId = "cascade-child";
  const codeDir = join(agentDir, "home", "proj-h");
  mkdirSync(codeDir, { recursive: true });
  writeFileSync(join(codeDir, "README.md"), "the code folder must outlive its sessions\n");
  const projectDir = join(agentDir, "sessions", "proj-h");
  mkdirSync(projectDir, { recursive: true });
  const parentFile = join(projectDir, `p_${parentId}.jsonl`);
  const childFile = join(projectDir, `c_${childId}.jsonl`);
  const line = (value) => JSON.stringify(value);
  const stamped = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(parentFile, [
    line({ type: "session", version: 3, id: parentId, timestamp: stamped, cwd: codeDir }),
    line({ type: "message", id: "m1", parentId: null, timestamp: stamped, message: { role: "user", content: "parent prompt" } }),
  ].join("\n") + "\n", "utf8");
  writeFileSync(childFile, [
    line({ type: "session", version: 3, id: childId, timestamp: stamped, cwd: codeDir, parentSession: parentFile }),
    line({
      type: "custom",
      customType: "pi-web:subagent",
      id: "meta",
      parentId: null,
      timestamp: stamped,
      data: { version: 1, parentSessionId: parentId, parentSessionPath: parentFile, profile: "Explore", description: "Cascade probe" },
    }),
    line({ type: "message", id: "m2", parentId: "meta", timestamp: stamped, message: { role: "user", content: "child prompt" } }),
  ].join("\n") + "\n", "utf8");
  invalidateSessionListCache();

  const key = (await identityOf({ id: parentId })).key;
  assert.ok(key);
  assert.equal((await identityOf({ id: parentId })).key, key, "the scan must see the planted family under that identity");

  const response = await postJson({ projectKey: key, confirm: "confirm" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual([...result.deletedSessionIds].sort(), [childId, parentId].sort());
  assert.deepEqual(result.failed, []);
});
