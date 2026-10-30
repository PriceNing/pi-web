// [fork] package.json 结构化合并的单元测试。
import test from "node:test";
import assert from "node:assert/strict";
import { mergePackageJson } from "../scripts/merge-package-json.mjs";

const ours = {
  name: "@pricening/pi-web",
  version: "0.12.1",
  description: "Web UI (personal fork)",
  homepage: "https://github.com/PriceNing/pi-web#readme",
  repository: { type: "git", url: "git+https://github.com/PriceNing/pi-web.git" },
  bugs: { url: "https://github.com/PriceNing/pi-web/issues" },
  publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
  forkedFrom: { name: "@agegr/pi-web", version: "0.12.1", commit: "f83b1a5" },
  dependencies: { a: "1.0.0" },
  devDependencies: { b: "2.0.0" },
  engines: { node: ">=22.19.0" },
};

const theirs = {
  name: "@agegr/pi-web",
  version: "0.12.2",
  description: "Web UI",
  homepage: "https://github.com/agegr/pi-web#readme",
  repository: { type: "git", url: "git+https://github.com/agegr/pi-web.git" },
  bugs: { url: "https://github.com/agegr/pi-web/issues" },
  dependencies: { a: "1.0.0", c: "3.0.0" },
  devDependencies: { b: "2.0.0", d: "4.0.0" },
  engines: { node: ">=22.19.0" },
  scripts: { build: "next build" },
};

test("包名是我们的，不是上游的", () => {
  assert.equal(mergePackageJson(ours, theirs).name, "@pricening/pi-web");
});

test("描述、主页、仓库、issues 都是我们的", () => {
  const merged = mergePackageJson(ours, theirs);
  assert.equal(merged.description, ours.description);
  assert.equal(merged.homepage, ours.homepage);
  assert.equal(merged.repository.url, ours.repository.url);
  assert.equal(merged.bugs.url, ours.bugs.url);
});

test("publishConfig 与 forkedFrom 保留我们的", () => {
  const merged = mergePackageJson(ours, theirs);
  assert.deepEqual(merged.publishConfig, ours.publishConfig);
  assert.deepEqual(merged.forkedFrom, ours.forkedFrom);
});

test("上游新增的依赖不会丢（这正是不能整块取 ours 的原因）", () => {
  const merged = mergePackageJson(ours, theirs);
  assert.equal(merged.dependencies.c, "3.0.0");
  assert.equal(merged.devDependencies.d, "4.0.0");
  assert.equal(merged.dependencies.a, "1.0.0");
});

test("上游的 scripts 与 engines 取上游", () => {
  const merged = mergePackageJson(ours, theirs);
  assert.deepEqual(merged.scripts, theirs.scripts);
  assert.deepEqual(merged.engines, theirs.engines);
});

test("version 保留 ours（发版流程会自己覆盖）", () => {
  assert.equal(mergePackageJson(ours, theirs).version, "0.12.1");
});

test("键的顺序把 name/version 放在最前", () => {
  const keys = Object.keys(mergePackageJson(ours, theirs));
  assert.equal(keys[0], "name");
  assert.equal(keys[1], "version");
});

test("上游没有的 our-only 字段照样保留（publishConfig 是我们发布必需的）", () => {
  const merged = mergePackageJson(ours, { name: "@agegr/pi-web", version: "0.0.1" });
  assert.deepEqual(merged.publishConfig, ours.publishConfig);
  assert.deepEqual(merged.forkedFrom, ours.forkedFrom);
});

test("我们独有的依赖不会因为合并而消失", () => {
  const merged = mergePackageJson(
    { ...ours, dependencies: { a: "1.0.0", onlyOurs: "9.9.9" } },
    theirs,
  );
  assert.equal(merged.dependencies.onlyOurs, "9.9.9");
  assert.equal(merged.dependencies.c, "3.0.0", "上游的依赖也要在");
  assert.equal(merged.dependencies.a, "1.0.0", "同名的取上游的值");
});
