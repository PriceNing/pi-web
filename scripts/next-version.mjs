#!/usr/bin/env node
// [pin-fork] Fork version policy, single source of truth.
//
// The upstream update checker (lib/app-update.ts) only understands plain
// `x.y.z`. A prerelease suffix such as `0.9.1-pin.1` makes isNewerStableVersion()
// return false forever, so the "update available" banner silently dies. The fork
// therefore uses a plain numeric sequence:
//
//   next = max(upstream version in package.json, highest published version + 0.0.1)
//
// Right after an upstream sync this equals the upstream version, so
// `npm info @pricening/pi-web version` still tells you which upstream build you
// are on. Extra fork-only releases just walk the patch number up.
//
// Usage:
//   node scripts/next-version.mjs                 # print the computed version
//   node scripts/next-version.mjs --published 0.9.4
//   node scripts/next-version.mjs --write         # also update package.json

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseStable(version) {
  const match = STABLE.exec(String(version ?? "").trim());
  if (!match) return null;
  return match.slice(1).map(Number);
}

export function compareStable(a, b) {
  const left = parseStable(a);
  const right = parseStable(b);
  if (!left || !right) throw new Error(`not a plain x.y.z version pair: ${a} / ${b}`);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function bumpPatch(version) {
  const parts = parseStable(version);
  if (!parts) throw new Error(`cannot bump a non-stable version: ${version}`);
  const [major, minor, patch] = parts;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * @param upstreamVersion version currently in package.json (post upstream merge)
 * @param publishedVersion highest version already on the registry ("0.0.0" if none)
 */
export function resolveNextVersion(upstreamVersion, publishedVersion) {
  const published = parseStable(publishedVersion) ? publishedVersion : "0.0.0";
  if (!parseStable(upstreamVersion)) {
    throw new Error(`package.json version must be x.y.z, got ${upstreamVersion}`);
  }
  // The published head must already be contained in this line of history, so we
  // never republish an existing number and never go backwards.
  const floor = compareStable(published, "0.0.0") === 0 ? null : bumpPatch(published);
  if (floor && compareStable(upstreamVersion, floor) < 0) return floor;
  return upstreamVersion;
}

function readPackageVersion() {
  const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
  return JSON.parse(raw).version;
}

if (process.argv[1] && process.argv[1].endsWith("next-version.mjs")) {
  const args = process.argv.slice(2);
  const publishedFlag = args.indexOf("--published");
  const upstream = readPackageVersion();
  const published = publishedFlag >= 0 ? args[publishedFlag + 1] : "0.0.0";
  const next = resolveNextVersion(upstream, published);

  if (args.includes("--write")) {
    const path = join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(path, "utf8"));
    pkg.version = next;
    writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
  }
  console.log(next);
}
