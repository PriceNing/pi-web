// [fork] 上游文件不被本 fork 修改：这是「以后不再撞冲突」的根本保证。
//
// 规则（docs/FORK.md §12）：
//   上游的文件保持与上游**逐字一致**。需要扩展就新建文件、在调用点接线；
//   实在必须改的，写进 scripts/merge-upstream.mjs 的策略表，由合并脚本按既定
//   方向自动解，不再靠人工每次临场判断。
//
// 这个测试拿本仓库的 upstream/main 逐字节对比。CI 里 upstream remote 存在时
// 才生效；本地没有 upstream ref 时跳过（不制造假失败）。

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** 这些文件必须与上游逐字一致（我们只在新文件里接线）。 */
const UPSTREAM_OWNED = [
  "app/api/sessions/[id]/route.ts",
  "lib/session-delete.ts",
];

function hasUpstream() {
  try {
    execFileSync("git", ["rev-parse", "--verify", "upstream/main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

const skip = hasUpstream() ? false : "本仓库没有 upstream/main ref（CI 里才有）";

test("本 fork 改过的上游文件都在合并策略表里登记", { skip }, () => {
  const policy = readFileSync(new URL("../scripts/merge-upstream.mjs", import.meta.url), "utf8");
  for (const file of UPSTREAM_OWNED) {
    assert.match(
      policy,
      new RegExp(`"${file.replace(/[[\]/]/g, "\\$&")}"\\s*:`),
      `${file} 与上游一致，但它没登记在策略表里`,
    );
  }
});

test("上游文件与 upstream/main 逐字一致", { skip }, () => {
  for (const file of UPSTREAM_OWNED) {
    const upstream = execFileSync("git", ["show", `upstream/main:${file}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const ours = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.equal(ours, upstream, `${file} 与上游不一致；要么改回上游版本，要么登记进策略表并新建接线文件`);
  }
});

test("我们的接线在自己的文件里，不塞进上游的文件", () => {
  const compat = readFileSync(new URL("../lib/session-delete-compat.ts", import.meta.url), "utf8");
  assert.match(compat, /from "@\/lib\/session-delete"/);
  assert.match(compat, /export class SessionNotFoundError/);
  assert.match(compat, /export async function deleteSessionById/);
});
