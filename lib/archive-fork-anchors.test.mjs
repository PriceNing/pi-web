import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// [archive-fork] Canary tests for the fork's integration seams.
//
// After upstream v0.11.0 the archive flag lives in the sidebar's unified UI state
// (`lib/session-ui-state*.ts`), so the old pins.json / archives.json call sites in
// the hot files are gone. What these canaries guard is what the feature still
// depends on: this page reading through the unified store, identity coming from
// the server, the bulk delete keeping its refusal conditions, and the settings
// registration that makes the page reachable without a cwd.

const source = (relative) => readFileSync(join(process.cwd(), relative), "utf8");

test("the archives page reads through the unified store and does not invent a writer", () => {
  const route = source("app/api/archives/route.ts");
  assert.match(route, /readSessionUiState\(/);
  // Writes belong to the sidebar's own endpoint; this view is read-only now.
  assert.doesNotMatch(route, /export async function POST\(/);
  assert.match(source("app/api/sessions/ui-state/route.ts"), /export async function POST\(/);
  // The unarchive action uses the request shape `session-ui-state-shared.ts` already defines.
  const page = source("components/ArchivesConfig.tsx");
  assert.match(page, /action:\s*"set"/);
  assert.match(page, /archived:\s*false/);
  assert.match(page, /"\/api\/sessions\/ui-state"/);
});

test("identity stays server-side: the page groups by the key the API computed", () => {
  const route = source("app/api/archives/route.ts");
  assert.match(route, /workspaceKeyOf\(/);
  // No path-based identity assembly in the client bundle (§3.2: keep Node paths out of it).
  const page = source("components/ArchivesConfig.tsx");
  assert.doesNotMatch(page, /from "node:path"|from "path"/);
  assert.doesNotMatch(page, /require\("path"\)/);
});

test("the bulk delete keeps every refusal condition", () => {
  const route = source("app/api/archives/sessions/route.ts");
  // Invalid body and an empty/non-string projectKey answer 400.
  assert.match(route, /Invalid JSON body/, "the 400 for an unparsable body");
  assert.match(route, /projectKey must be a non-empty string/, "the 400 for a bad projectKey");
  // Nothing to delete answers 404 before anything else is considered.
  assert.match(route, /No sessions found for this project/, "the 404 for an empty project");
  // A running agent in the project answers 409 with its ids.
  assert.match(route, /runningSessionIds/, "the 409 body for a running agent");
  assert.match(route, /getRunningRpcSessionIds\(\)/, "the running-agent check itself");
  // Confirm word: English plus both Chinese confirmations.
  assert.match(route, /word === "confirm"/);
  assert.ok(route.includes('=== "确认"') || route.includes('=== "\u786E\u8BA4"'), "zh-CN confirm");
  assert.ok(route.includes('=== "確認"') || route.includes('=== "\u78BA\u8A8D"'), "zh-TW confirm");
  // Deletion is delegated, so the shared cascade/re-parent rules stay in force.
  assert.match(route, /deleteSessionById\(/);
  // And the code folder is never deleted here.
  assert.doesNotMatch(route, /unlinkSync|rmSync|rmdirSync|readFileSync\(.*\.jsonl/);
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

test("the page keeps its labels built in instead of the i18n catalog (§3.2)", () => {
  const page = source("components/ArchivesConfig.tsx");
  assert.match(page, /const LABELS/);
  for (const block of [/\ben:\s*{/, /"zh-CN":\s*{/, /"zh-TW":\s*{/]) {
    assert.ok(block.test(page), `the built-in label block for ${block}`);
  }
  // The forbidden file: adding keys there means a conflict on every upstream sync.
  assert.doesNotMatch(page, /lib\/i18n\/messages/);
  assert.doesNotMatch(page, /\bt\("/);
});
