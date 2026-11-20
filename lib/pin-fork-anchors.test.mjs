import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// [pin-fork] Canary test for the fork's integration seams.
//
// The pin feature hangs off a handful of upstream call sites. If a future
// upstream refactor moves or renames one of them, the feature would silently
// stop working while every other test stayed green. These assertions turn that
// silent failure into a build failure.

const source = (relative) => readFileSync(join(process.cwd(), relative), "utf8");

test("SessionSidebar feeds our comparator from upstream's unified UI state", () => {
  const sidebar = source("components/SessionSidebar.tsx");
  // After adopting upstream's store the sidebar keeps one marker here; the row
  // buttons/hooks it used to carry are upstream's own controls now.
  const markers = sidebar.match(/\[pin-fork\]/g) ?? [];
  assert.ok(
    markers.length >= 1,
    `expected at least 1 [pin-fork] marker in SessionSidebar.tsx, found ${markers.length}`,
  );
  // Our contribution survives through upstream's hook feeding the cold seams below.
  assert.match(sidebar, /useSessionUiState\(\)/);
  assert.match(sidebar, /uiState\.sessions/);
  assert.match(sidebar, /uiState\.projects/);
  // Ordering seams: both lists must still receive the pin sets.
  assert.match(sidebar, /listSessionFamilies\(allSessions,\s*pinnedFamilyRootIds\)/);
  assert.match(sidebar, /getRecentProjects\(allSessions,\s*pinnedProjectKeys\)/);
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

test("the server ships the unified UI state's revision on the poll", () => {
  // Upstream's revision field is what the poll carries now, and it is what the
  // sidebar's optimistic writes ride on.
  assert.match(source("app/api/agent/running/route.ts"), /sessionUiStateRevision/);
});

test("the retired pin/archive stores are gone for good", () => {
  // The unified UI state (upstream's pi-web-session-state.json) is the only
  // truth source since v0.11.0. The old two-file stores and the routes that
  // wrote them are deleted, so nothing can write a pin or an archive flag into
  // a file no reader looks at any more.
  for (const gone of [
    "lib/pin-store.ts",
    "lib/archive-store.ts",
    "app/api/pins/route.ts",
    "hooks/usePins.ts",
    "hooks/useArchives.ts",
    "components/PinButton.tsx",
    "components/ArchiveButton.tsx",
  ]) {
    assert.equal(existsSync(join(process.cwd(), gone)), false, `${gone} should be deleted`);
  }
  // The list route must stay byte-identical to upstream's: our side of it only
  // pruned the retired stores, so it no longer carries any fork marker.
  const listRoute = source("app/api/sessions/route.ts");
  assert.doesNotMatch(listRoute, /prunePins|pruneArchives|pin-store|archive-store/);
});

test("the legacy stores are imported once into the unified state", () => {
  // A machine that upgrades from the pre-v0.11.0 fork still holds pins.json and
  // archives.json. Without an import, those pins and archives would silently
  // disappear from the sidebar. The importer is wired into a fork-owned route,
  // and it refuses to run once the unified state exists.
  const once = source("lib/ui-state-migrate-once.ts");
  assert.match(once, /migrateLegacyUiState\(\)/);
  assert.match(once, /attempted/);

  const archives = source("app/api/archives/route.ts");
  assert.match(archives, /migrateLegacyUiStateOnce\(\)/);

  // The importer itself reads the legacy files by path, so it keeps working
  // after the store modules are gone.
  const migrate = source("lib/ui-state-migrate.ts");
  assert.match(migrate, /join\(agentDir, "pi-web", "pins\.json"\)/);
  assert.match(migrate, /join\(agentDir, "pi-web", "archives\.json"\)/);
});

test("pin-order stays importable from the browser bundle", () => {
  const order = source("lib/pin-order.ts");
  // No Node-only modules, or the client bundle would break on import.
  assert.doesNotMatch(order, /from "node:/);
  assert.doesNotMatch(order, /from "fs"|from "path"|from "os"/);
  assert.doesNotMatch(order, /next\/server/);
});

test("the retired pin store never wrote into pi-owned config paths", () => {
  // Historical note kept as a guard for the importer, which is the only thing
  // that still touches the legacy files: it reads them and never rewrites a
  // pi-owned path.
  const migrate = source("lib/ui-state-migrate.ts");
  assert.doesNotMatch(migrate, /"sessions\.json"|getSettingsPath|settings\.json/);
  assert.doesNotMatch(migrate, /writeFileSync\(\s*sessionsDir/);
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
