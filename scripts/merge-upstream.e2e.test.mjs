// [fork] 合并脚本的端到端演练：在临时 git 仓库里造出三种情形，
// 证明策略化合并真的按预期工作（而不是只测纯逻辑）。
//
// 情形一：README.md 双方都改（策略 ours）→ 自动解，保留我们的门面。
// 情形二：上游删掉 README.zh-CN.md（上游 2026-10-14 那次吞掉中文门面的手法）
//         → 合并脚本把门面恢复回来。
// 情形三：上游新增一个我们没见过的文件（真冲突）→ 停下并报告，不猜方向。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncUpstream, conflictedFiles } from "../scripts/merge-upstream.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** 造一个 fork 仓库 + 上游仓库，共享同一个 remote。 */
function makeRepos() {
  const root = mkdtempSync(join(tmpdir(), "pi-web-merge-"));
  const upstream = join(root, "upstream");
  const fork = join(root, "fork");
  execFileSync("git", ["init", "--initial-branch=main", upstream], { encoding: "utf8" });
  execFileSync("git", ["init", "--initial-branch=main", fork], { encoding: "utf8" });
  for (const dir of [upstream, fork]) {
    git(dir, ["config", "user.name", "t"]);
    git(dir, ["config", "user.email", "t@example.com"]);
  }
  // 上游的初始内容
  writeFileSync(join(upstream, "README.md"), "upstream readme\n", "utf8");
  writeFileSync(join(upstream, "README.zh-CN.md"), "上游中文译文\n", "utf8");
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-m", "upstream init"]);
  // fork 从上游起步，再放我们自己的门面
  git(fork, ["remote", "add", "upstream", upstream]);
  git(fork, ["fetch", "upstream", "main"]);
  git(fork, ["checkout", "-b", "main", "FETCH_HEAD"]);
  writeFileSync(join(fork, "README.md"), "our readme\n", "utf8");
  writeFileSync(join(fork, "README.zh-CN.md"), "我们的中文门面\n", "utf8");
  git(fork, ["add", "-A"]);
  git(fork, ["commit", "-m", "fork init"]);
  return { root, upstream, fork };
}

test("情形一：README 冲突按 ours 自动解掉", () => {
  const { fork, upstream } = makeRepos();
  // 上游改 README.md
  writeFileSync(join(upstream, "README.md"), "upstream readme v2\n", "utf8");
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-m", "upstream edits readme"]);
  git(fork, ["fetch", "upstream", "main"]);
  const result = syncUpstream({ cwd: fork, fetchOrigin: false });
  assert.equal(result.ok, true, `应当自动解冲突: ${result.notes.join("; ")}`);
  assert.deepEqual(result.manual, []);
  assert.ok(result.resolved.includes("README.md"), `README.md 应被策略自动解: ${result.resolved.join(", ")}`);
  const merged = readFileSync(join(fork, "README.md"), "utf8");
  assert.match(merged, /our readme/, "README.md 应保留我们的门面");
  assert.equal(conflictedFiles(fork).length, 0, "不应残留冲突");
});

test("情形二：上游删掉门面，脚本把它恢复", () => {
  const { fork, upstream } = makeRepos();
  git(upstream, ["rm", "-q", "README.zh-CN.md"]);
  git(upstream, ["commit", "-m", "upstream drops the zh readme"]);
  git(fork, ["fetch", "upstream", "main"]);
  const result = syncUpstream({ cwd: fork, fetchOrigin: false });
  assert.equal(result.ok, true, `应当成功: ${result.notes.join("; ")}`);
  assert.ok(existsSync(join(fork, "README.zh-CN.md")), "中文门面应被恢复");
  assert.match(readFileSync(join(fork, "README.zh-CN.md"), "utf8"), /我们的中文门面/);
});

test("情形三：方向不明的冲突停下并报告，不猜", () => {
  const { fork, upstream } = makeRepos();
  writeFileSync(join(upstream, "docs-new.md"), "upstream new file\n", "utf8");
  writeFileSync(join(fork, "docs-new.md"), "fork new file\n", "utf8");
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-m", "upstream adds a file"]);
  git(fork, ["add", "-A"]);
  git(fork, ["commit", "-m", "fork adds the same file"]);
  git(fork, ["fetch", "upstream", "main"]);
  const result = syncUpstream({ cwd: fork, fetchOrigin: false });
  assert.equal(result.ok, false, "方向不明时不该继续");
  assert.deepEqual(result.manual, ["docs-new.md"]);
  assert.match(result.notes.join(" "), /需判断/);
});

test("情形四：package.json 的冲突按字段结构化合成", () => {
  const { fork, upstream } = makeRepos();
  const pkg = (name, version, extra = {}) =>
    JSON.stringify({ name, version, description: `${name} desc`, ...extra }, null, 2);
  writeFileSync(join(upstream, "package.json"), pkg("@agegr/pi-web", "0.12.2", {
    dependencies: { upstreamDep: "1.0.0" },
  }), "utf8");
  writeFileSync(join(fork, "package.json"), pkg("@pricening/pi-web", "0.12.1", {
    publishConfig: { access: "public" },
    dependencies: { forkDep: "2.0.0" },
  }), "utf8");
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-m", "upstream rewrites package.json"]);
  git(fork, ["add", "-A"]);
  git(fork, ["commit", "-m", "fork rewrites package.json"]);
  git(fork, ["fetch", "upstream", "main"]);
  const result = syncUpstream({ cwd: fork, fetchOrigin: false });
  assert.equal(result.ok, true, `package.json 应自动合: ${result.notes.join("; ")}`);
  const merged = JSON.parse(readFileSync(join(fork, "package.json"), "utf8"));
  assert.equal(merged.name, "@pricening/pi-web", "包名取我们的");
  assert.deepEqual(merged.publishConfig, { access: "public" }, "publishConfig 取我们的");
  assert.equal(merged.dependencies.upstreamDep, "1.0.0", "上游依赖不能丢");
  assert.equal(merged.dependencies.forkDep, "2.0.0", "我们的依赖不能丢");
});

test("情形五：上游改名搬走门面时，门面照样恢复", () => {
  const { fork, upstream } = makeRepos();
  // 上游把 README.zh-CN.md 改名成 docs/README.zh-CN.md（旧内容）
  mkdirSync(join(upstream, "docs"), { recursive: true });
  git(upstream, ["mv", "README.zh-CN.md", "docs/README.zh-CN.md"]);
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-m", "upstream moves the zh readme into docs"]);
  git(fork, ["fetch", "upstream", "main"]);
  const result = syncUpstream({ cwd: fork, fetchOrigin: false });
  assert.equal(result.ok, true, `应当成功: ${result.notes.join("; ")}`);
  assert.ok(existsSync(join(fork, "README.zh-CN.md")), "我们的门面应恢复");
  assert.match(readFileSync(join(fork, "README.zh-CN.md"), "utf8"), /我们的中文门面/);
});
