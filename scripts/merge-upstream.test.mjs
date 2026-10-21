// [fork] 合并策略的单元测试：纯逻辑，不碰 git。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { POLICY, MUST_KEEP, resolveByPolicy, readReport, REPORT_FILE } from "../scripts/merge-upstream.mjs";

const script = readFileSync(new URL("../scripts/merge-upstream.mjs", import.meta.url), "utf8");

test("策略表把 fork 门面定为 ours", () => {
  assert.equal(POLICY["README.md"], "ours");
  assert.equal(POLICY["README.zh-CN.md"], "ours");
});

test("策略表把上游自己的文档译文定为 theirs", () => {
  assert.equal(POLICY["docs/README.ja.md"], "theirs");
  assert.equal(POLICY["docs/README.ru.md"], "theirs");
  assert.equal(POLICY["docs/README.zh-CN.md"], "theirs");
});

test("上游负责的代码文件定为 theirs", () => {
  assert.equal(POLICY["app/api/sessions/[id]/route.ts"], "theirs");
  assert.equal(POLICY["lib/session-delete.ts"], "theirs");
});

test("策略表里的路径都真实存在（路径写错就会静默失效）", () => {
  for (const file of Object.keys(POLICY)) {
    assert.ok(
      existsSync(new URL(`../${file}`, import.meta.url)),
      `策略表里的 ${file} 不存在`,
    );
  }
});

test("门面文件被钉住：上游删掉也要恢复", () => {
  for (const file of ["README.md", "README.zh-CN.md", "README.ja.md", "README.ru.md", "docs/FORK.md"]) {
    assert.ok(MUST_KEEP.includes(file), `${file} 不在 MUST_KEEP 里`);
  }
});

test("MUST_KEEP 里的文件都真实存在", () => {
  for (const file of MUST_KEEP) {
    assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} 不存在`);
  }
});

test("四个语言门面互相链接，且没有死链", () => {
  const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  for (const file of ["README.md", "README.zh-CN.md", "README.ja.md", "README.ru.md"]) {
    const body = read(file);
    for (const match of body.matchAll(/\]\((\.\/[^)]+)\)/g)) {
      const target = match[1].replace("./", "");
      assert.ok(existsSync(new URL(`../${target}`, import.meta.url)), `${file} 里的死链: ${target}`);
    }
  }
});

test("每个语言门面都提到 npm 包名，不指向官方包", () => {
  for (const file of ["README.md", "README.zh-CN.md", "README.ja.md", "README.ru.md"]) {
    const body = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(body, /@pricening\/pi-web/, `${file} 没提 @pricening/pi-web`);
  }
});

test("方向已定的文件自动解决，需要判断的留下", () => {
  const files = ["README.md", "docs/README.ja.md", "components/SomethingNew.tsx"];
  const { resolved, manual } = resolveByPolicy(files, { dryRun: true });
  assert.deepEqual(resolved.sort(), ["README.md", "docs/README.ja.md"]);
  assert.deepEqual(manual, ["components/SomethingNew.tsx"]);
});

test("未知文件不猜测方向", () => {
  const { resolved, manual } = resolveByPolicy(["lib/brand-new-upstream-file.ts"], { dryRun: true });
  assert.deepEqual(resolved, []);
  assert.deepEqual(manual, ["lib/brand-new-upstream-file.ts"]);
});

test("报告文件缺失时读到 null", () => {
  assert.equal(readReport(process.cwd() + "/nonexistent-dir"), null);
});

test("报告文件名固定，CI 与本地读同一个", () => {
  assert.equal(REPORT_FILE, ".merge-upstream-report.json");
});

test("脚本自己会 fetch origin 并折进发版标记", () => {
  assert.match(script, /"fetch",\s*"--no-tags",\s*"--prune",\s*"origin"/);
  assert.match(script, /"merge",\s*"--no-edit",\s*"origin\/main"/);
});

test("上游 fetch 仍然不取 tag", () => {
  assert.match(script, /\+refs\/heads\/main:refs\/remotes\/upstream\/main/);
  assert.match(script, /"--no-tags"/);
});

test("需要判断时会开 issue，不让断更静悄悄发生", () => {
  assert.match(script, /gh", \["issue", "create"/);
});
