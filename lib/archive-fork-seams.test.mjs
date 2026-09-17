import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
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
