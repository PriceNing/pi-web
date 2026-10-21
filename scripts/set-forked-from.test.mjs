import assert from "node:assert/strict";
import test from "node:test";
import { applyForkedFrom, stringifyPackageJson } from "./set-forked-from.mjs";

function base() {
  return {
    name: "@pricening/pi-web",
    version: "0.9.6",
    forkedFrom: {
      name: "@agegr/pi-web",
      version: "0.9.1",
      commit: "fcd94bf797235f192c58a0cc774da405da9e0b68",
      url: "https://github.com/agegr/pi-web",
    },
  };
}

test("the upstream commit is refreshed while our own version stays ours", () => {
  const upstream = {
    version: "0.9.1",
    commit: "20ad98bc91ebfc0802574456de25b0258711036e",
  };
  const result = applyForkedFrom(base(), upstream);
  assert.equal(result.changed, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.pkg.forkedFrom.commit, upstream.commit);
  assert.equal(result.pkg.version, "0.9.6");
  assert.equal(result.pkg.name, "@pricening/pi-web");
});

test("an unchanged upstream writes nothing, so CI stays idempotent", () => {
  const input = base();
  const upstream = {
    version: "0.9.1",
    commit: input.forkedFrom.commit,
  };
  const result = applyForkedFrom(input, upstream);
  assert.equal(result.changed, false);
  assert.equal(result.pkg, input);
});

test("missing arguments keep recorded values instead of blanking them", () => {
  const input = base();
  const result = applyForkedFrom(input, {});
  assert.equal(result.changed, false);
  assert.equal(result.pkg.forkedFrom.version, "0.9.1");
  assert.ok(result.pkg.forkedFrom.commit.startsWith("fcd94bf"));
});

test("a missing forkedFrom block is created with upstream defaults", () => {
  const result = applyForkedFrom({ name: "x" }, {
    version: "1.2.3",
    commit: "abcdef1234567890",
  });
  assert.equal(result.changed, true);
  assert.equal(result.pkg.forkedFrom.name, "@agegr/pi-web");
  assert.equal(result.pkg.forkedFrom.url, "https://github.com/agegr/pi-web");
});

test("impossible values are warned about rather than silently stored", () => {
  const badVersion = applyForkedFrom(base(), {
    version: "v0.9",
    commit: "fcd94bf797235f192c58a0cc774da405da9e0b68",
  });
  assert.ok(badVersion.warnings.some((w) => /not x\.y\.z/.test(w)));

  const badCommit = applyForkedFrom(base(), {
    version: "0.9.1",
    commit: "main",
  });
  assert.ok(badCommit.warnings.some((w) => /hex sha/.test(w)));
});

test("serialisation keeps the two-space style package.json uses", () => {
  const text = stringifyPackageJson(base());
  assert.ok(text.includes('\n  "forkedFrom"'));
  assert.ok(text.endsWith("\n"));
  assert.deepEqual(JSON.parse(text).forkedFrom.commit.length, 40);
});
