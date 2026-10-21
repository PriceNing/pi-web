import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

// [pin-fork] Behavioural tests for the two ordering seams. The canary test only
// proves the hooks are still wired; these prove the hooks actually reorder.

const jiti = createJiti(import.meta.url);
const { listSessionFamilies } = await jiti.import("./session-family.ts");
const { getRecentProjects } = await jiti.import("./project-groups.ts");

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

test("pinned sessions come first and the rest keep activity order", () => {
  const sessions = [
    session("new", "2026-09-05T00:00:00.000Z"),
    session("mid", "2026-09-03T00:00:00.000Z"),
    session("pinned-old", "2026-08-01T00:00:00.000Z"),
  ];

  assert.deepEqual(
    listSessionFamilies(sessions).map((family) => family.root.id),
    ["new", "mid", "pinned-old"],
  );
  assert.deepEqual(
    listSessionFamilies(sessions, new Set(["pinned-old"])).map((family) => family.root.id),
    ["pinned-old", "new", "mid"],
  );
});

test("pinned sessions stay ordered by activity inside their group", () => {
  const sessions = [
    session("a", "2026-09-01T00:00:00.000Z"),
    session("b", "2026-09-09T00:00:00.000Z"),
    session("c", "2026-09-05T00:00:00.000Z"),
  ];
  assert.deepEqual(
    listSessionFamilies(sessions, new Set(["a", "c"])).map((family) => family.root.id),
    ["c", "a", "b"],
  );
});

test("a pinned family is matched by its root id even when a subagent is newer", () => {
  const sessions = [
    session("root", "2026-08-01T00:00:00.000Z"),
    session("other", "2026-09-08T00:00:00.000Z"),
    session("child", "2026-09-09T00:00:00.000Z", {
      relation: {
        kind: "subagent",
        parentSessionId: "root",
        profile: "worker",
        description: "d",
        status: "completed",
      },
    }),
  ];
  const families = listSessionFamilies(sessions, new Set(["root"]));
  assert.deepEqual(families.map((family) => family.root.id), ["root", "other"]);
  assert.equal(families[0].subagents.length, 1);
});

test("pinning a subagent id alone does not promote it into a row of its own", () => {
  const sessions = [
    session("root", "2026-08-01T00:00:00.000Z"),
    session("other", "2026-09-08T00:00:00.000Z"),
    session("child", "2026-09-09T00:00:00.000Z", {
      relation: {
        kind: "subagent",
        parentSessionId: "root",
        profile: "worker",
        description: "d",
        status: "completed",
      },
    }),
  ];
  // Only visible families are reorderable; subagents are grouped, not listed.
  // The family's own order already bubbles subagent activity into latestModified.
  const unpinned = listSessionFamilies(sessions).map((family) => family.root.id);
  const pinnedByChild = listSessionFamilies(sessions, new Set(["child"])).map((family) => family.root.id);
  assert.deepEqual(pinnedByChild, unpinned);
  // Pinning the root does move it, which is the intended user-facing behaviour.
  const pinnedByRoot = listSessionFamilies(sessions, new Set(["root"])).map((family) => family.root.id);
  assert.equal(pinnedByRoot[0], "root");
});

test("pinned projects come first and the rest keep activity order", () => {
  const sessions = [
    session("s1", "2026-09-09T00:00:00.000Z", { projectRoot: "/tmp/new", projectKey: "key-new" }),
    session("s2", "2026-09-01T00:00:00.000Z", { projectRoot: "/tmp/old", projectKey: "key-old" }),
  ];

  assert.deepEqual(
    getRecentProjects(sessions).map((project) => project.key),
    ["key-new", "key-old"],
  );
  assert.deepEqual(
    getRecentProjects(sessions, new Set(["key-old"])).map((project) => project.key),
    ["key-old", "key-new"],
  );
});

test("project pins use the server identity key, and display paths are preserved", () => {
  const sessions = [
    session("s1", "2026-09-09T00:00:00.000Z", { projectRoot: "D:\\work\\alpha", projectKey: "d:\\work\\alpha" }),
    session("s2", "2026-09-01T00:00:00.000Z", { projectRoot: "D:\\work\\beta", projectKey: "d:\\work\\beta" }),
  ];
  const pinned = getRecentProjects(sessions, new Set(["d:\\work\\beta"]));
  assert.deepEqual(pinned.map((project) => project.key), ["d:\\work\\beta", "d:\\work\\alpha"]);
  // The pin key is the normalised identity; the row still shows the real path.
  assert.equal(pinned[0].root, "D:\\work\\beta");
});

test("both seams are backward compatible when no pin set is supplied", () => {
  const sessions = [session("a", "2026-09-01T00:00:00.000Z")];
  assert.equal(listSessionFamilies(sessions, undefined).length, 1);
  assert.equal(getRecentProjects(sessions, undefined).length, 1);
  assert.equal(getRecentProjects(sessions).length, 1);
});
