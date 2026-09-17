import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// [pin-fork] Canary test for the fork's integration seams.
//
// The pin feature hangs off a handful of upstream call sites. If a future
// upstream refactor moves or renames one of them, the feature would silently
// stop working while every other test stayed green. These assertions turn that
// silent failure into a build failure.

const source = (relative) => readFileSync(join(process.cwd(), relative), "utf8");

test("SessionSidebar keeps the pin hooks and its marker comments", () => {
  const sidebar = source("components/SessionSidebar.tsx");
  const markers = sidebar.match(/\[pin-fork\]/g) ?? [];
  assert.ok(
    markers.length >= 6,
    `expected at least 6 [pin-fork] markers in SessionSidebar.tsx, found ${markers.length}`,
  );
  // Ordering seams: both lists must still receive the pin sets.
  assert.match(sidebar, /listSessionFamilies\(filteredSessions,\s*pinSets\.sessions\)/);
  assert.match(sidebar, /getRecentProjects\(allSessions,\s*pinSets\.projects,\s*archiveSet\)/);
  // The poll must still adopt the server's pin payload.
  assert.match(sidebar, /applyPinPayload\(data\.pins\)/);
  // Session rows must still receive pin state.
  assert.match(sidebar, /pinned=\{pinSets\.sessions\.has\(family\.root\.id\)\}/);
  assert.match(sidebar, /onTogglePin=\{togglePin\}/);
});

test("the ordering seams still delegate to the shared comparator", () => {
  const families = source("lib/session-family.ts");
  assert.match(families, /export function listSessionFamilies\(/);
  assert.match(families, /pinnedSessionIds\?: ReadonlySet<string>/);
  assert.match(families, /comparePinnedFirst\(/);

  const projects = source("lib/project-groups.ts");
  assert.match(projects, /export function getRecentProjects\(/);
  assert.match(projects, /pinnedProjectKeys\?: ReadonlySet<string>/);
  assert.match(projects, /comparePinnedFirst\(/);
});

test("the server still ships pins on the poll and prunes on the list load", () => {
  assert.match(source("app/api/agent/running/route.ts"), /pins:\s*getPinsPayload\(\)/);
  assert.match(source("app/api/sessions/route.ts"), /await prunePins\(\{/);
  assert.match(source("app/api/pins/route.ts"), /export async function POST\(/);
});

test("pin-order stays importable from the browser bundle", () => {
  const order = source("lib/pin-order.ts");
  // No Node-only modules, or the client bundle would break on import.
  assert.doesNotMatch(order, /from "node:/);
  assert.doesNotMatch(order, /from "fs"|from "path"|from "os"/);
  assert.doesNotMatch(order, /next\/server/);
});

test("the pin store never writes into pi-owned config paths", () => {
  const store = source("lib/pin-store.ts");
  assert.match(store, /join\(agentDir, "pi-web", "pins\.json"\)/);
  // Session files and pi's settings.json must stay untouched by this feature.
  assert.doesNotMatch(store, /"sessions\.json"|getSettingsPath|settings\.json/);
  assert.doesNotMatch(store, /writeFileSync\(\s*sessionsDir/);
});

test("fork identity: the package and update check describe the fork", async () => {
  const pkg = JSON.parse(source("package.json"));
  assert.equal(pkg.name, "@pricening/pi-web");
  // The upstream update checker only understands x.y.z. A prerelease suffix
  // (0.9.1-pin.1) silently disables "update available" forever, so the fork
  // uses a plain numeric sequence and records the upstream base separately.
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.forkedFrom.name, "@agegr/pi-web");
  assert.equal(pkg.publishConfig.registry, "https://registry.npmjs.org/");

  // The banner must never offer to "upgrade" to an unpatched upstream release.
  assert.match(
    source("app/api/app-update/route.ts"),
    /registry\.npmjs\.org\/@pricening%2Fpi-web\/latest/,
  );
  assert.doesNotMatch(source("app/api/app-update/route.ts"), /@agegr%2Fpi-web/);
  assert.match(
    source("lib/app-update.ts"),
    /github\.com\/PriceNing\/pi-web\/releases\/tag/,
  );
});
