import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// [pin-fork] 品牌版本号宽度的金丝雀（2026-11-18）。
//
// 上游的 components/PiWebTitle.test.mjs 断言「版本号文本再多一位数字也放得下」，
// 那是按上游自己的短版本（0.17.x）写的。我们的版本是 0.12.x，多一个字符：
// 0.12.10 起文本本身放得下，但「再多一位」的余量已经被我们已有的补丁位吃掉。
// 于是那个文件登记进 POLICY 取 ours，fork 副本只去掉那条余量断言。
//
// 这个金丝雀替它站岗：
//   1. 当前版本文本必须真的放得下（不是只把断言删了就完事）；
//   2. 版本长到放不下时**大声失败**，并说清楚该做什么（那是设计决策，
//      不是测试问题：要么缩字号/加宽侧栏下限，要么改版本显示格式）；
//   3. fork 副本与 POLICY 登记不被静默还原。

const source = (relative) => readFileSync(join(process.cwd(), relative), "utf8");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SIDEBAR_MIN_WIDTH } = await jiti.import("@/lib/panel-layout.ts");
const { brandVersionText } = await jiti.import("../components/PiWebTitle.tsx");

const packageJson = JSON.parse(source("package.json"));
const piPackage = JSON.parse(
  readFileSync(
    join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    "utf8",
  ),
);

// 与上游测试同一套算法：chevron 列的 6px 缩进 + 开关的 5px，
// 侧栏最窄时去掉边框和 New/搜索两个 36px 格子，11px 等宽字每字符 0.6em。
function widthRoom() {
  const css = source("app/sidebar.css");
  const brand = css.match(/\.sidebar-brand \{[^}]*\}/)?.[0] ?? "";
  const marginLeft = Number(brand.match(/margin: 0 0 0 (\d+)px;/)?.[1]);
  const paddingLeft = Number(brand.match(/padding: \d+px (\d+)px;/)?.[1]);
  assert.ok(Number.isFinite(marginLeft) && Number.isFinite(paddingLeft), "sidebar-brand 的 margin/padding 读不出来");
  assert.equal(marginLeft + paddingLeft, 6 + 5);
  const room = SIDEBAR_MIN_WIDTH - 1 - 36 - 36;
  const box = (text) => marginLeft + 2 * paddingLeft + text.length * 0.6 * 11;
  return { room, box };
}

test("the fork's version text fits the brand box at the sidebar's minimum", () => {
  const { room, box } = widthRoom();
  const versions = brandVersionText(packageJson.version, piPackage.version);
  assert.ok(
    box(versions) <= room,
    `版本 "${versions}" 在侧栏最窄时放不下了（${box(versions).toFixed(1)}px > ${room}px）。` +
      "这是设计决策不是测试问题：缩 data-fit=2 的字号、加宽 SIDEBAR_MIN_WIDTH，" +
      "或改品牌上的版本显示格式。见 docs/FORK.md 的品牌宽度一节。",
  );
});

test("the upstream headroom assumption stays replaced, and the policy keeps it that way", () => {
  const forkCopy = source("components/PiWebTitle.test.mjs");
  // fork 副本的标记还在，且当前版本的 fit 断言没被删。
  assert.match(forkCopy, /\[pin-fork\] Upstream keeps room for one more digit/);
  assert.match(forkCopy, /assert\.ok\(box\(versions, 11\) <= room/);
  // 上游那条「再多一位」断言不能悄悄回来（我们的版本方案下它必挂）。
  assert.doesNotMatch(forkCopy, /and a digit more/);
  // POLICY 登记还在，合并才会继续取我们的副本。
  const script = source("scripts/merge-upstream.mjs");
  assert.match(script, /"components\/PiWebTitle\.test\.mjs":\s*"ours"/);
});
