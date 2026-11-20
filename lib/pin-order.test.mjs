import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  MAX_PIN_KEY_LENGTH,
  comparePinnedFirst,
  emptyPinSets,
  normalizePinKey,
  normalizePinKind,
  parsePinsPayload,
  pinSetsOf,
  pinsChanged,
  prunePinMap,
} = await createJiti(import.meta.url).import("./pin-order.ts");

test("pinned items sort before non-pinned and equal sides defer to the caller", () => {
  assert.equal(comparePinnedFirst(true, false), -1);
  assert.equal(comparePinnedFirst(false, true), 1);
  // 0 lets the existing activity comparison decide the order.
  assert.equal(comparePinnedFirst(true, true), 0);
  assert.equal(comparePinnedFirst(false, false), 0);
});

test("a pinned-first comparator keeps activity order inside each group", () => {
  const items = [
    { id: "old-unpinned", modified: "2026-01-01", pinned: false },
    { id: "pinned-old", modified: "2026-01-02", pinned: true },
    { id: "new-unpinned", modified: "2026-05-05", pinned: false },
    { id: "pinned-new", modified: "2026-01-03", pinned: true },
  ];
  const ordered = [...items].sort((a, b) => comparePinnedFirst(a.pinned, b.pinned)
    || b.modified.localeCompare(a.modified));
  assert.deepEqual(ordered.map((item) => item.id), [
    "pinned-new",
    "pinned-old",
    "new-unpinned",
    "old-unpinned",
  ]);
});

test("payload parsing degrades to no pins instead of throwing", () => {
  assert.deepEqual(parsePinsPayload(undefined), { sessions: [], projects: [] });
  assert.deepEqual(parsePinsPayload(null), { sessions: [], projects: [] });
  assert.deepEqual(parsePinsPayload("nope"), { sessions: [], projects: [] });
  assert.deepEqual(parsePinsPayload({ sessions: "abc" }), { sessions: [], projects: [] });
  assert.deepEqual(parsePinsPayload({ sessions: [1, null, " b ", "", "a"] }), {
    sessions: ["a", "b"],
    projects: [],
  });
});

test("payload parsing dedupes and sorts keys so change detection is stable", () => {
  const first = parsePinsPayload({ sessions: ["b", "a", "a"] });
  const second = parsePinsPayload({ sessions: ["a", "b"] });
  assert.deepEqual(first, second);
  assert.equal(pinsChanged(pinSetsOf(first), pinSetsOf(second)), false);
});

test("pinsChanged reports only real differences", () => {
  const base = pinSetsOf(parsePinsPayload({ sessions: ["a"], projects: ["p"] }));
  assert.equal(pinsChanged(base, emptyPinSets()), true);
  assert.equal(pinsChanged(base, pinSetsOf(parsePinsPayload({ sessions: ["a"], projects: ["p"] }))), false);
  assert.equal(pinsChanged(base, pinSetsOf(parsePinsPayload({ sessions: ["a", "b"], projects: ["p"] }))), true);
});

test("request key validation rejects empty, non-string and oversized keys", () => {
  assert.equal(normalizePinKey("  abc  "), "abc");
  assert.equal(normalizePinKey(""), null);
  assert.equal(normalizePinKey("   "), null);
  assert.equal(normalizePinKey(42), null);
  assert.equal(normalizePinKey("x".repeat(MAX_PIN_KEY_LENGTH + 1)), null);
});

test("pin kind validation is exact", () => {
  assert.equal(normalizePinKind("session"), "session");
  assert.equal(normalizePinKind("project"), "project");
  assert.equal(normalizePinKind("Session"), null);
  assert.equal(normalizePinKind(undefined), null);
});

test("prunePinMap removes only unknown keys and reports the count", () => {
  const map = { a: { pinnedAt: "1" }, b: { pinnedAt: "2" } };
  const kept = prunePinMap(map, new Set(["a", "b"]));
  assert.equal(kept.removed, 0);
  assert.equal(kept.map, map);

  const pruned = prunePinMap(map, new Set(["a"]));
  assert.equal(pruned.removed, 1);
  assert.deepEqual(Object.keys(pruned.map), ["a"]);
});
