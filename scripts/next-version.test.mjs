import assert from "node:assert/strict";
import test from "node:test";
import {
  bumpPatch,
  compareStable,
  resolveNextVersion,
} from "./next-version.mjs";

test("versions compare numerically per component, not as strings", () => {
  assert.ok(compareStable("0.9.10", "0.9.9") > 0);
  assert.ok(compareStable("0.10.0", "0.9.9") > 0);
  assert.equal(compareStable("0.9.1", "0.9.1"), 0);
  assert.ok(compareStable("0.9.0", "0.9.1") < 0);
});

test("the fork follows the upstream number right after a sync", () => {
  assert.equal(resolveNextVersion("0.9.2", "0.9.1"), "0.9.2");
  assert.equal(resolveNextVersion("0.9.2", "0.0.0"), "0.9.2");
});

test("fork-only releases walk the patch number up instead of colliding", () => {
  // Upstream is still 0.9.1 but we already shipped 0.9.1 and a hotfix 0.9.2.
  assert.equal(resolveNextVersion("0.9.1", "0.9.2"), "0.9.3");
  assert.equal(resolveNextVersion("0.9.1", "0.9.1"), "0.9.2");
});

test("a version behind the published head is never reused", () => {
  assert.equal(resolveNextVersion("0.9.1", "0.10.0"), "0.10.1");
});

test("prerelease versions are rejected, because the update checker ignores them", () => {
  assert.throws(() => resolveNextVersion("0.9.1-pin.1", "0.0.0"), /must be x\.y\.z/);
  assert.throws(() => bumpPatch("0.9.1-beta.2"), /non-stable/);
});
