#!/usr/bin/env node
// [fork] package.json 的结构化合并：把「上游的依赖 + 我们的身份」合成一份。
//
// 为什么不能用 git 的 ours/theirs：
//   两边都改的是同一个区块（文件头），git 只能整块取一边。
//   取 ours → 丢掉上游新增的依赖和脚本；取 theirs → 丢掉我们的包名、
//   publishConfig、forkedFrom。这正是每次同步都要人工解 package.json 的原因。
//
// 规则（每一类字段一个方向，方向永不变）：
//   ours   我们的身份字段：name / description / homepage / repository / bugs /
//          publishConfig / forkedFrom。forkedFrom 的 version+commit 由
//          scripts/set-forked-from.mjs 在合并后自动写，所以这里原样保留 ours。
//   theirs 其余一切：dependencies / devDependencies / scripts / engines /
//          exports 等上游负责的内容。version 不在这里——版本号由发版流程决定
//          （scripts/next-version.mjs 算，workflow 里 npm version 写）。
//
// 用法：node scripts/merge-package-json.mjs <ours.json> <theirs.json> <out.json>

import { readFileSync, writeFileSync } from "node:fs";

/** 永远是我们的字段。 */
const OURS_FIELDS = [
  "name",
  "description",
  "homepage",
  "repository",
  "bugs",
  "publishConfig",
  "forkedFrom",
];

/** 合成两份 package.json：ours 的身份 + theirs 的其余。 */
export function mergePackageJson(ours, theirs) {
  const merged = { ...theirs };
  for (const field of OURS_FIELDS) {
    if (ours[field] !== undefined) merged[field] = ours[field];
    else delete merged[field];
  }
  // version：保留我们这一侧的值。发版流程会按 next-version.mjs 的结果覆盖它，
  // 合并阶段不动它，免得把「已经发过的版本」提前降级。
  if (ours.version !== undefined) merged.version = ours.version;
  // 依赖：以上游为准（同名的取上游的版本——上游在它们上面测过），
  // 但**我们独有的依赖要留下**（上游没有的包不能因为合并而消失）。
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const oursSection = ours[section];
    if (!oursSection) continue;
    const base = { ...(theirs[section] ?? {}) };
    for (const [name, range] of Object.entries(oursSection)) {
      if (!(name in base)) base[name] = range;
    }
    if (Object.keys(base).length > 0) merged[section] = base;
  }
  // 键的顺序：先 name/version/description 这种头几项，再其余，和上游一致。
  const head = ["name", "version", "description", "homepage"];
  const ordered = {};
  for (const key of head) {
    if (merged[key] !== undefined) ordered[key] = merged[key];
  }
  for (const key of Object.keys(merged)) {
    if (!head.includes(key)) ordered[key] = merged[key];
  }
  return ordered;
}

function main() {
  const [, , oursPath, theirsPath, outPath] = process.argv;
  if (!oursPath || !theirsPath || !outPath) {
    console.error("用法: node scripts/merge-package-json.mjs <ours.json> <theirs.json> <out.json>");
    process.exit(1);
  }
  const ours = JSON.parse(readFileSync(oursPath, "utf8"));
  const theirs = JSON.parse(readFileSync(theirsPath, "utf8"));
  const merged = mergePackageJson(ours, theirs);
  writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(`[merge-package-json] 合成完成: ${merged.name}@${merged.version}`);
}

if (process.argv[1] && process.argv[1].endsWith("merge-package-json.mjs")) {
  main();
}
