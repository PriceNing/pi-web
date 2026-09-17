import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  MAX_ARCHIVE_KEY_LENGTH,
  archiveSetOf,
  archiveSetsDiffer,
  emptyArchivesPayload,
  normalizeArchiveKey,
  parseArchivesPayload,
  pruneArchiveMap,
} = await createJiti(import.meta.url).import("./archive-order.ts");

test("payload parsing degrades to no archives instead of throwing", () => {
  assert.deepEqual(parseArchivesPayload(undefined), emptyArchivesPayload());
  assert.deepEqual(parseArchivesPayload(null), emptyArchivesPayload());
  assert.deepEqual(parseArchivesPayload("nope"), emptyArchivesPayload());
  assert.deepEqual(parseArchivesPayload({ projects: "abc" }), { projects: [] });
  assert.deepEqual(parseArchivesPayload({ projects: [1, null, " b ", "", "a"] }), {
    projects: ["a", "b"],
  });
});

test("legacy `archives` field is accepted as an alias of `projects`", () => {
  assert.deepEqual(parseArchivesPayload({ archives: ["z", "a"] }), { projects: ["a", "z"] });
});

test("payload parsing dedupes and sorts keys", () => {
  const first = parseArchivesPayload({ projects: ["b", "a", "a"] });
  const second = parseArchivesPayload({ projects: ["a", "b"] });
  assert.deepEqual(first, second);
  assert.equal(archiveSetsDiffer(archiveSetOf(first), archiveSetOf(second)), false);
});

test("archiveSetsDiffer reports only real differences", () => {
  const base = archiveSetOf(parseArchivesPayload({ projects: ["p"] }));
  assert.equal(archiveSetsDiffer(base, archiveSetOf(emptyArchivesPayload())), true);
  assert.equal(archiveSetsDiffer(base, archiveSetOf(parseArchivesPayload({ projects: ["p"] }))), false);
  assert.equal(archiveSetsDiffer(base, archiveSetOf(parseArchivesPayload({ projects: ["p", "q"] }))), true);
});

test("request key validation rejects empty, non-string and oversized keys", () => {
  assert.equal(normalizeArchiveKey("  abc  "), "abc");
  assert.equal(normalizeArchiveKey(""), null);
  assert.equal(normalizeArchiveKey("   "), null);
  assert.equal(normalizeArchiveKey(42), null);
  assert.equal(normalizeArchiveKey("x".repeat(MAX_ARCHIVE_KEY_LENGTH + 1)), null);
});

test("pruneArchiveMap removes only unknown keys", () => {
  const map = { a: { archivedAt: "1" }, b: { archivedAt: "2" } };
  const kept = pruneArchiveMap(map, new Set(["a", "b"]));
  assert.equal(kept.removed, 0);
  assert.equal(kept.map, map);

  const pruned = pruneArchiveMap(map, new Set(["a"]));
  assert.equal(pruned.removed, 1);
  assert.deepEqual(Object.keys(pruned.map), ["a"]);
});
