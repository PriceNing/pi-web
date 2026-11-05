// [fork] 解构并集合并的单元测试：纯逻辑，不碰 git。
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDestructuring,
  mergeDestructuring,
  resolveDestructuringConflicts,
} from "../scripts/merge-destructuring.mjs";

test("能读出解构声明的各部分", () => {
  const parsed = parseDestructuring("  const { t, locale } = useI18n();");
  assert.equal(parsed.indent, "  ");
  assert.deepEqual(parsed.items, ["t", "locale"]);
  assert.equal(parsed.suffix, " } = useI18n();");
});

test("不是解构声明的行返回 null", () => {
  assert.equal(parseDestructuring("  const x = 1;"), null);
  assert.equal(parseDestructuring("  return { a, b };"), null);
});

test("两边各加一项 → 取并集", () => {
  const result = mergeDestructuring(
    "  const { t } = useI18n();",
    "  const { t, locale } = useI18n();",
    "  const { t, newFeature } = useI18n();",
  );
  assert.ok(result);
  assert.equal(result.merged, "  const { t, locale, newFeature } = useI18n();");
  assert.deepEqual(result.added, ["newFeature"]);
});

test("不同的调用不算同一件事 → null", () => {
  const result = mergeDestructuring(
    "  const { t } = useI18n();",
    "  const { t, locale } = useI18n();",
    "  const { t, other } = useOther();",
  );
  assert.equal(result, null);
});

test("上游删过项（base 有、theirs 没有）→ 方向不明，null", () => {
  const result = mergeDestructuring(
    "  const { t, gone } = useI18n();",
    "  const { t, gone } = useI18n();",
    "  const { t } = useI18n();",
  );
  assert.equal(result, null);
});

test("我们删过项（base 有、ours 没有）→ 方向不明，null", () => {
  const result = mergeDestructuring(
    "  const { t, gone } = useI18n();",
    "  const { t } = useI18n();",
    "  const { t, gone } = useI18n();",
  );
  assert.equal(result, null);
});

test("上游没改这一行（我们已含它）→ null（没有要合并的）", () => {
  const result = mergeDestructuring(
    "  const { t } = useI18n();",
    "  const { t, newFeature } = useI18n();",
    "  const { t, newFeature } = useI18n();",
  );
  assert.equal(result, null);
});

test("解开真实的冲突块形状（上游 v0.15.0 vs 我们的归档页）", () => {
  const base = [
    "  const [section, setSection] = useState<SettingsSection>(initialSection);",
    "  const { t } = useI18n();",
    "  const [mounted, setMounted] = useState(true);",
    "",
  ].join("\n");
  const text = [
    "  const [section, setSection] = useState<SettingsSection>(initialSection);",
    "<<<<<<< HEAD",
    "  const { t, locale } = useI18n();",
    "=======",
    "  const { t, newFeature } = useI18n();",
    ">>>>>>> theirs",
    "  const [mounted, setMounted] = useState(true);",
    "",
  ].join("\n");
  const result = resolveDestructuringConflicts(text, base);
  assert.ok(result);
  assert.equal(result.text.includes("<<<<<<<"), false);
  assert.match(result.text, /const \{ t, locale, newFeature \} = useI18n\(\);/);
});

test("ours 侧带注释行 → 保留注释，代码取并集", () => {
  const base = "  const { t } = useI18n();\n";
  const text = [
    "<<<<<<< HEAD",
    "  // [archive-fork] 我们的说明",
    "  const { t, locale } = useI18n();",
    "=======",
    "  const { t, newFeature } = useI18n();",
    ">>>>>>> theirs",
    "",
  ].join("\n");
  const result = resolveDestructuringConflicts(text, base);
  assert.ok(result);
  assert.match(result.text, /\/\/ \[archive-fork\] 我们的说明/);
  assert.match(result.text, /const \{ t, locale, newFeature \} = useI18n\(\);/);
});

test("冲突块里有别的改动（不只是解构）→ 交回给人判断", () => {
  const base = "  const { t } = useI18n();\n";
  const text = [
    "<<<<<<< HEAD",
    "  const { t, locale } = useI18n();",
    "  const extra = 1;",
    "=======",
    "  const { t, newFeature } = useI18n();",
    ">>>>>>> theirs",
    "",
  ].join("\n");
  assert.equal(resolveDestructuringConflicts(text, base), null);
});

test("CRLF 行尾（Windows 上的工作区）也能解开", () => {
  const base = "  const { t } = useI18n();\r\n";
  const text = [
    "<<<<<<< HEAD",
    "  // [archive-fork] 我们的说明",
    "  const { t, locale } = useI18n();",
    "=======",
    "  const { t, newFeature } = useI18n();",
    ">>>>>>> theirs",
    "",
  ].join("\r\n");
  const result = resolveDestructuringConflicts(text, base);
  assert.ok(result, "CRLF 文件不该被判成无法自动解");
  assert.match(result.text, /const \{ t, locale, newFeature \} = useI18n\(\);/);
});

test("没有 base 可对照 → 交回给人判断（不做无根据的猜测）", () => {
  const text = [
    "<<<<<<< HEAD",
    "  const { t, locale } = useI18n();",
    "=======",
    "  const { t, newFeature } = useI18n();",
    ">>>>>>> theirs",
    "",
  ].join("\n");
  assert.equal(resolveDestructuringConflicts(text, "  完全不同的一行\n"), null);
});

test("没有冲突块 → null", () => {
  assert.equal(resolveDestructuringConflicts("  const x = 1;\n"), null);
});
