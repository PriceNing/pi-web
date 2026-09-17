import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = (relative) => readFileSync(join(process.cwd(), relative), "utf8");

test("SessionSidebar keeps the archive hooks and its marker comments", () => {
  const sidebar = source("components/SessionSidebar.tsx");
  const markers = sidebar.match(/\[archive-fork\]/g) ?? [];
  assert.ok(
    markers.length >= 4,
    `expected at least 4 [archive-fork] markers in SessionSidebar.tsx, found ${markers.length}`,
  );
  assert.match(sidebar, /getRecentProjects\(allSessions,\s*pinSets\.projects,\s*archiveSet\)/);
  assert.match(sidebar, /applyArchivePayload\(data\.archives\)/);
  assert.match(sidebar, /onToggle=\{toggleArchive\}/);
  assert.match(sidebar, /!archiveSet\.has\(key\)/);
});

test("the project grouping seam still accepts an archived-key filter", () => {
  const projects = source("lib/project-groups.ts");
  assert.match(projects, /export function getRecentProjects\(/);
  assert.match(projects, /archivedProjectKeys\?: ReadonlySet<string>/);
});

test("the server still ships archives on the poll and prunes on the list load", () => {
  assert.match(source("app/api/agent/running/route.ts"), /archives:\s*getArchivesPayload\(\)/);
  assert.match(source("app/api/sessions/route.ts"), /await pruneArchives\(\{/);
  assert.match(source("app/api/archives/route.ts"), /export async function POST\(/);
  assert.match(source("app/api/archives/sessions/route.ts"), /export async function POST\(/);
});

test("archive-order stays importable from the browser bundle", () => {
  const order = source("lib/archive-order.ts");
  assert.doesNotMatch(order, /from "node:/);
  assert.doesNotMatch(order, /from "fs"|from "path"|from "os"/);
  assert.doesNotMatch(order, /next\/server/);
});

test("the archive store never writes into pi-owned config paths", () => {
  const store = source("lib/archive-store.ts");
  assert.match(store, /join\(agentDir, "pi-web", "archives\.json"\)/);
  assert.doesNotMatch(store, /"sessions\.json"|getSettingsPath|settings\.json/);
  assert.doesNotMatch(store, /writeFileSync\(\s*sessionsDir/);
});

test("session deletion is shared by the route and the archive bulk delete", () => {
  assert.match(source("app/api/sessions/[id]/route.ts"), /deleteSessionById\(/);
  assert.match(source("app/api/archives/sessions/route.ts"), /deleteSessionById\(/);
  assert.match(source("lib/session-delete.ts"), /export async function deleteSessionById/);
});

test("settings expose a global archives section that does not require a cwd", () => {
  const nav = source("lib/settings-navigation.ts");
  assert.match(nav, /"archives"/);
  assert.doesNotMatch(nav, /PROJECT_SECTIONS = new Set<SettingsSection>\(\[[^\]]*archives/);
  assert.match(source("components/SettingsPanel.tsx"), /ArchivesConfig/);
});
