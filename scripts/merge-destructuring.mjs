// [fork] 上游合并的一个自动解法：双方只往同一个解构里各加了一项。
//
// 为什么需要它（2026-11-05 实测）：
//
//   上游 v0.15.0 把手机端设置改成分页导航，它在 components/SettingsPanel.tsx
//   里加了一整组常量与函数；而我们在同一个文件里加的是归档页的接线。
//   第一次合并时，两边恰好在同一个区域各自新增，冲突块有 88 行（我们的 5 行
//   混在上游的 83 行里），人得读两边才能判断。
//
//   把我们的接线挪进 fork 自有的文件之后，冲突块缩到了 **1 行**：
//
//     <<<<<<< HEAD
//       const { t, locale } = useI18n();
//     =======
//       const { t, newFeature } = useI18n();
//     >>>>>>> theirs
//
//   这一行的意思只有一个：两边各自往同一个解构里加了一项。方向明确，
//   结果也唯一：**取并集**。这类冲突应该是机器解的，不是人解的。
//
// 这里的合并只处理**同一行的解构声明**，不碰别的：
//   - 两边必须都是 `const { … } = 标识(…)` 的形状；
//   - 标识和调用必须完全一样（否则不是同一件事）；
//   - 解构项的名字不能重复（重复说明有一边删过东西，方向不明）；
//   - 其余部分（注释、空格、默认值）保持 ours。
//
// 任何一条不满足，就返回 null —— 交回给人判断，绝不猜。

/**
 * 从一行里取出解构声明的各个部分。
 * @param {string} line
 * @returns {{indent: string, prefix: string, items: string[], suffix: string} | null}
 */
export function parseDestructuring(line) {
  const match = /^(\s*)(const|let|var)\s*\{\s*([^}]*)\}\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(([^)]*)\)\s*;?\s*$/.exec(line);
  if (!match) return null;
  const [, indent, keyword, rawItems, callee, args] = match;
  const items = rawItems
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) return null;
  return {
    indent,
    prefix: `${keyword} {`,
    items,
    suffix: ` } = ${callee}(${args});`,
  };
}

/**
 * 两行解构声明能否自动合并成并集。
 *
 * 用三方（base/ours/theirs）而不是两边，因为「对方没有的项」有两种可能：
 * 是自己加的，还是对方删的。只有 base 能区分：
 *   - base 有、ours 有、theirs 没有 → 上游删了 → 方向不明；
 *   - base 没有、ours 有、theirs 没有 → 是自己加的 → 保留；
 *   - base 没有、theirs 有、ours 没有 → 上游加的 → 保留。
 *
 * @param {string} base 合并前的共同祖先那一行
 * @param {string} ours 我们这一行
 * @param {string} theirs 上游那一行
 * @returns {{merged: string, added: string[]} | null}
 */
export function mergeDestructuring(base, ours, theirs) {
  const a = parseDestructuring(ours);
  const b = parseDestructuring(theirs);
  const ancestor = parseDestructuring(base);
  if (!a || !b || !ancestor) return null;
  // 同一个变量、同一个调用 —— 否则不是同一件事，方向不明。
  if (a.suffix !== b.suffix) return null;
  if (a.prefix !== b.prefix) return null;
  if (ancestor.suffix !== b.suffix) return null;

  const oursSet = new Set(a.items);
  const theirsSet = new Set(b.items);

  // 上游删过东西（base 有、ours 有、theirs 没有）→ 方向不明，交回给人。
  const removedByThem = ancestor.items.filter((item) => oursSet.has(item) && !theirsSet.has(item));
  if (removedByThem.length > 0) return null;
  // 我们删过东西（base 有、theirs 有、ours 没有）→ 同样方向不明。
  const removedByUs = ancestor.items.filter((item) => theirsSet.has(item) && !oursSet.has(item));
  if (removedByUs.length > 0) return null;

  // 两边各自新增的项 → 取并集。
  const added = b.items.filter((item) => !oursSet.has(item));
  if (added.length === 0) return null;

  const merged = [...a.items];
  for (const item of added) {
    if (!merged.includes(item)) merged.push(item);
  }
  if (merged.length !== new Set(merged).size) return null;
  return {
    merged: `${a.indent}${a.prefix} ${merged.join(", ")}${a.suffix}`,
    added,
  };
}

/**
 * 把一段带冲突标记的文本里，双方只改了解构声明的冲突块解开。
 *
 * 只处理「双方改的是同一个解构声明」的情况 —— 这是 2026-11-05 那个真实
 * 冲突的形状。任何更复杂的情况都返回 null。
 *
 * 一侧可能还带着自己的注释（比如 ours 侧是「两行注释 + 一行代码」），
 * 这不影响语义：注释保留 ours 的，代码取并集。
 *
 * @param {string} text 带冲突标记的文本
 * @param {string} baseText 合并前（base）那一版的内容，用来区分「新增」与「删除」
 * @returns {{text: string, resolved: string[]} | null}
 */
export function resolveDestructuringConflicts(text, baseText = "") {
  // 行尾必须是 \r?\n：Windows 上 checkout 出来的工作区是 CRLF，而合并脚本
  // 本地也跑（而且这台机器就是 Windows）。用 \n 结尾的正则在 CRLF 文件上
  // 一个块都匹配不到，于是明明能解的冲突也会被判成「要人判断」。
  const pattern = /^<<<<<<< [^\n]*\r?\n([\s\S]*?)^=======\r?\n([\s\S]*?)^>>>>>>> [^\n]*\r?\n?/gm;
  const blocks = [...text.matchAll(pattern)];
  if (blocks.length === 0) return null;

  const baseLines = baseText.split(/\r?\n/);
  const resolved = [];
  let output = text;

  /** 从一段文本里取出「代码行」和「它前面的注释行」。 */
  const splitCode = (raw) => {
    const lines = raw.replace(/\r?\n$/, "").split(/\r?\n/);
    const codeIndex = lines.findIndex((line) => parseDestructuring(line) !== null);
    if (codeIndex === -1) return null;
    return {
      comments: lines.slice(0, codeIndex).filter((line) => line.trim().startsWith("//")),
      code: lines[codeIndex],
    };
  };

  for (const block of blocks) {
    const oursSide = splitCode(block[1]);
    const theirsSide = splitCode(block[2]);
    if (!oursSide || !theirsSide) return null;
    // 注释之外的行必须只有代码那一行 —— 有别的改动就方向不明。
    const oursExtra = block[1].replace(/\r?\n$/, "").split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trim().startsWith("//") && line !== oursSide.code);
    const theirsExtra = block[2].replace(/\r?\n$/, "").split(/\r?\n/).filter((line) => line.trim() !== "" && line !== theirsSide.code);
    if (oursExtra.length > 0 || theirsExtra.length > 0) return null;

    // base 里对应的那一行：合并前双方共同的版本。base 的那一行内容与两边
    // 都不同（它是原样），所以不能按文本相等来匹配 —— 按**解析出的形状**
    // 匹配：同一个变量、同一个调用的解构声明就是那一个。
    //
    // 但同一个文件里可能有几处形状相同的解构（例如两处都调 useI18n()），
    // 只按形状匹配会挑错行。所以还要挑**那一处真正的共同祖先**：它的项
    // 必须同时是 ours 和 theirs 的子集 —— 双方都保留着 base 的那些项。
    const shapeOf = (line) => {
      const parsed = parseDestructuring(line);
      return parsed ? `${parsed.prefix}|${parsed.suffix}` : null;
    };
    const oursShape = shapeOf(oursSide.code);
    const oursItems = new Set(parseDestructuring(oursSide.code)?.items ?? []);
    const theirsItems = new Set(parseDestructuring(theirsSide.code)?.items ?? []);
    const candidates = baseLines.filter((line) => shapeOf(line) === oursShape);
    const baseLine = candidates.find((line) => {
      const items = new Set(parseDestructuring(line)?.items ?? []);
      return [...items].every((item) => oursItems.has(item) && theirsItems.has(item));
    }) ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (baseLine === undefined) return null;

    const result = mergeDestructuring(baseLine, oursSide.code, theirsSide.code);
    if (!result) return null;
    // 我们的注释保留（它解释的是我们为什么要 locale），但要改掉里面
    // 已经过时的说法。
    const merged = [...oursSide.comments, result.merged].join("\n");
    resolved.push(result.merged);
    output = output.replace(block[0], `${merged}\n`);
  }
  return { text: output, resolved };
}
