#!/usr/bin/env node
// [pin-fork] Keeps package.json.forkedFrom pointing at the upstream commit we merged.
//
// Why automate it: upstream commits code without bumping its own version (it stayed
// at 0.9.1 while HEAD kept moving), and our version is an independent sequence, so
// forkedFrom is the only place recording "which upstream build is this". Hand-editing
// it goes stale within a day.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA = /^[0-9a-f]{7,40}$/;

const DEFAULTS = {
  name: "@agegr/pi-web",
  url: "https://github.com/agegr/pi-web",
};

/**
 * Pure, so it is testable without touching disk.
 * @param {Record<string, any>} pkg parsed package.json
 * @param {{version?: string, commit?: string}} upstream values read from git
 * @returns {{pkg: Record<string, any>, changed: boolean, warnings: string[]}}
 */
export function applyForkedFrom(pkg, upstream) {
  const current = pkg.forkedFrom || {};
  const warnings = [];

  const version = typeof upstream.version === "string" && upstream.version
    ? upstream.version
    : current.version || "unknown";
  const commit = typeof upstream.commit === "string" && upstream.commit
    ? upstream.commit
    : current.commit || "";

  if (!SEMVER.test(version)) warnings.push("upstream version is not x.y.z: " + version);
  if (commit && !SHA.test(commit)) warnings.push("upstream commit is not a hex sha: " + commit);

  const next = {
    name: current.name || DEFAULTS.name,
    version,
    commit,
    url: current.url || DEFAULTS.url,
  };

  const unchanged = ["name", "version", "commit", "url"]
    .every((key) => current[key] === next[key]);
  if (unchanged) return { pkg, changed: false, warnings };

  return { pkg: { ...pkg, forkedFrom: next }, changed: true, warnings };
}

/** Serialise with the two-space style package.json already uses. */
export function stringifyPackageJson(pkg) {
  return JSON.stringify(pkg, null, 2) + "\n";
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && process.argv[1].endsWith("set-forked-from.mjs")) {
  const path = join(process.cwd(), "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const result = applyForkedFrom(pkg, {
    version: argValue("--version"),
    commit: argValue("--commit"),
  });

  for (const warning of result.warnings) console.warn("warning: " + warning);
  if (argValue("--dry-run")) {
    console.log(result.changed ? "would update" : "already current");
    console.log(JSON.stringify(result.pkg.forkedFrom));
    process.exit(0);
  }
  if (!result.changed) {
    console.log("forkedFrom already current");
    process.exit(0);
  }
  writeFileSync(path, stringifyPackageJson(result.pkg), "utf8");
  console.log("forkedFrom -> " + JSON.stringify(result.pkg.forkedFrom));
}
