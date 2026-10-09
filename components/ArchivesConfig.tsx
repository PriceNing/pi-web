"use client";

// [archive-fork] Settings page for the unified store's archives.
//
// Archive itself is a view flag the sidebar owns (`lib/session-ui-state-shared.ts`
// has the rules, `/api/sessions/ui-state` does the writing); this page only reads
// the read-only view `GET /api/archives` gives it. Deleting sessions is the
// dangerous action and lives only here — never on the sidebar project row.
//
// Identity discipline: `key` comes from the server (`workspaceKeyOf`). The client
// treats it as an opaque id; paths are display only, so no path helpers belong in
// this bundle. Labels stay inside the component (§3.2: nothing goes into the
// i18n catalog), in the fork's three languages.

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { formatRelativeTime } from "@/lib/i18n/format";
import {
  chunkForSessionUiRequests,
  type SessionUiStateRequest,
} from "@/lib/session-ui-state-shared";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigDetailTitle,
  ConfigEmptyState,
  ConfigField,
  ConfigPanelShell,
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
} from "./SettingsUi";

/** `GET /api/archives` (server-computed identities + display paths). */
interface ArchivedFamilyRow {
  id: string;
  name?: string;
  firstMessage?: string;
  messageCount: number;
  modified: string;
  archivedAt: number;
}

interface ArchiveRow {
  key: string;
  root: string;
  families: ArchivedFamilyRow[];
}

type LabelKey =
  | "title"
  | "empty"
  | "loadFailed"
  | "sessions"
  | "unarchive"
  | "deleteSessions"
  | "deleteConfirmLead"
  | "deleteConfirmHint"
  | "deleteConfirmName"
  | "cancel"
  | "busy"
  | "runningBlocked"
  | "deleteFailed"
  | "path"
  | "untitled"
  | "messages";

const LABELS: Record<"en" | "zh-CN" | "zh-TW", Record<LabelKey, string>> = {
  en: {
    title: "Archives",
    empty: "No archived projects.",
    loadFailed: "Could not load archives.",
    sessions: "{count} sessions",
    unarchive: "Unarchive",
    deleteSessions: "Delete",
    deleteConfirmLead: "Deletes {count} chat sessions. Does not delete the code folder.",
    deleteConfirmHint: "Type confirm to continue.",
    deleteConfirmName: "confirm",
    cancel: "Cancel",
    busy: "Working…",
    runningBlocked: "Stop the running agent in this project first.",
    deleteFailed: "Could not delete those sessions.",
    path: "Path",
    untitled: "Untitled session",
    messages: "{count} messages",
  },
  "zh-CN": {
    title: "归档",
    empty: "没有已归档的项目。",
    loadFailed: "无法加载归档列表。",
    sessions: "{count} 个会话",
    unarchive: "取消归档",
    deleteSessions: "删除",
    deleteConfirmLead: "将删除该项目下 {count} 个聊天会话，不会删除磁盘上的代码目录。",
    deleteConfirmHint: "输入「确认」继续。",
    deleteConfirmName: "确认",
    cancel: "取消",
    busy: "处理中…",
    runningBlocked: "请先停止该项目中正在运行的 agent。",
    deleteFailed: "删除会话失败。",
    path: "路径",
    untitled: "未命名会话",
    messages: "{count} 条消息",
  },
  "zh-TW": {
    title: "封存",
    empty: "沒有已封存的專案。",
    loadFailed: "無法載入封存清單。",
    sessions: "{count} 個工作階段",
    unarchive: "取消封存",
    deleteSessions: "刪除",
    deleteConfirmLead: "將刪除該專案下 {count} 個聊天工作階段，不會刪除磁碟上的程式碼目錄。",
    deleteConfirmHint: "輸入「確認」繼續。",
    deleteConfirmName: "確認",
    cancel: "取消",
    busy: "處理中…",
    runningBlocked: "請先停止該專案中正在執行的 agent。",
    deleteFailed: "刪除工作階段失敗。",
    path: "路徑",
    untitled: "未命名工作階段",
    messages: "{count} 則訊息",
  },
};

const UI_STATE_URL = "/api/sessions/ui-state";

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (token, name: string) => (
    params[name] === undefined ? token : String(params[name])
  ));
}

/** Display only — the identity is the server's `key`, never a path. */
function lastPathSegment(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

function isDeleteConfirmation(value: string): boolean {
  const word = value.trim().toLowerCase();
  return word === "confirm" || word === "确认" || word === "確認";
}

function familyTitle(family: ArchivedFamilyRow, untitled: string): string {
  const named = family.name?.trim();
  if (named) return named;
  const first = family.firstMessage?.replace(/\s+/g, " ").trim();
  if (first && first !== "(no messages)") return first;
  return untitled;
}

export function ArchivesConfig({
  onClose,
  embedded = false,
}: {
  onClose: () => void;
  embedded?: boolean;
}) {
  const { locale } = useI18n();
  const strings = LABELS[locale] ?? LABELS.en;
  const [rows, setRows] = useState<ArchiveRow[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState("");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const [archiveRes, homeRes] = await Promise.all([
        fetch("/api/archives", { cache: "no-store" }),
        fetch("/api/home", { cache: "no-store" }),
      ]);
      if (!archiveRes.ok) throw new Error("load failed");
      const payload = await archiveRes.json() as { projects?: ArchiveRow[] };
      const homeData = await homeRes.json().catch(() => ({})) as { home?: string };
      if (typeof homeData.home === "string") setHomeDir(homeData.home);
      const projects = Array.isArray(payload.projects) ? payload.projects : [];
      setRows(projects);
      setSelectedKey((current) => (
        current && projects.some((row) => row.key === current) ? current : projects[0]?.key ?? null
      ));
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = rows.find((row) => row.key === selectedKey) ?? null;

  /**
   * Unarchive through the sidebar's writer (`POST /api/sessions/ui-state`): the
   * existing `set` action over family root ids, in request-sized chunks. One id
   * for a single row, every id of the project for the header button.
   */
  const unarchive = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const chunk of chunkForSessionUiRequests(ids)) {
        const request: SessionUiStateRequest = { action: "set", ids: chunk, archived: false };
        const res = await fetch(UI_STATE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`unarchive failed: ${res.status}`);
      }
      setConfirming(false);
      setConfirmText("");
      await load();
    } catch {
      setError(strings.loadFailed);
    } finally {
      setBusy(false);
    }
  };

  const deleteSessions = async (row: ArchiveRow) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/archives/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectKey: row.key,
          confirm: confirmText.trim(),
        }),
      });
      const data = await res.json().catch(() => ({})) as {
        error?: string;
        runningSessionIds?: string[];
      };
      if (res.status === 409 && data.runningSessionIds?.length) {
        setError(strings.runningBlocked);
        return;
      }
      if (!res.ok) throw new Error(data.error ?? "delete failed");
      setConfirming(false);
      setConfirmText("");
      setRows((prev) => prev.filter((item) => item.key !== row.key));
      setSelectedKey((current) => current === row.key ? null : current);
    } catch {
      setError(strings.deleteFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfigPanelShell
      embedded={embedded}
      title={strings.title}
      onClose={onClose}
    >
      {failed ? (
        <ConfigEmptyState>{strings.loadFailed}</ConfigEmptyState>
      ) : rows.length === 0 ? (
        <ConfigEmptyState>{strings.empty}</ConfigEmptyState>
      ) : (
        <ConfigSplitView>
          <ConfigSidebar>
            <ConfigSidebarList>
              {rows.map((row) => (
                <ConfigSidebarItem
                  key={row.key}
                  active={row.key === selectedKey}
                  onClick={() => {
                    setSelectedKey(row.key);
                    setConfirming(false);
                    setConfirmText("");
                    setError(null);
                  }}
                >
                  <ConfigSidebarText title={row.root}>
                    {lastPathSegment(row.root)}
                  </ConfigSidebarText>
                </ConfigSidebarItem>
              ))}
            </ConfigSidebarList>
          </ConfigSidebar>
          <ConfigDetail>
            {selected ? (
              <ConfigDetailStack>
                <ConfigDetailHeader>
                  <ConfigDetailHeaderInfo>
                    <ConfigDetailTitle>{lastPathSegment(selected.root)}</ConfigDetailTitle>
                  </ConfigDetailHeaderInfo>
                  <ConfigDetailActions>
                    <ConfigButton
                      variant="secondary"
                      size="small"
                      disabled={busy || selected.families.length === 0}
                      onClick={() => void unarchive(selected.families.map((family) => family.id))}
                    >
                      {busy ? strings.busy : strings.unarchive}
                    </ConfigButton>
                    {!confirming && (
                      <ConfigButton
                        variant="danger"
                        size="small"
                        disabled={busy || selected.families.length === 0}
                        onClick={() => { setConfirming(true); setConfirmText(""); setError(null); }}
                      >
                        {strings.deleteSessions}
                      </ConfigButton>
                    )}
                  </ConfigDetailActions>
                </ConfigDetailHeader>
                <ConfigField label={strings.path}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", wordBreak: "break-all" }}>
                    {displayCwd(selected.root, homeDir)}
                  </span>
                </ConfigField>
                {confirming && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                      {interpolate(strings.deleteConfirmLead, { count: selected.families.length })}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {strings.deleteConfirmHint}
                    </span>
                    <input
                      value={confirmText}
                      onChange={(event) => setConfirmText(event.target.value)}
                      placeholder={strings.deleteConfirmName}
                      aria-label={strings.deleteConfirmName}
                      autoComplete="off"
                      style={{
                        alignSelf: "flex-start",
                        width: "min(220px, 100%)",
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        padding: "6px 8px",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        background: "var(--bg)",
                        color: "var(--text)",
                      }}
                    />
                    <div style={{ display: "flex", gap: 8 }}>
                      <ConfigButton
                        variant="danger"
                        size="small"
                        disabled={busy || !isDeleteConfirmation(confirmText)}
                        onClick={() => void deleteSessions(selected)}
                      >
                        {busy ? strings.busy : strings.deleteSessions}
                      </ConfigButton>
                      <ConfigButton
                        variant="ghost"
                        size="small"
                        disabled={busy}
                        onClick={() => { setConfirming(false); setConfirmText(""); }}
                      >
                        {strings.cancel}
                      </ConfigButton>
                    </div>
                  </div>
                )}
                <ConfigSectionTitle>
                  {interpolate(strings.sessions, { count: selected.families.length })}
                </ConfigSectionTitle>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minHeight: 0, overflowY: "auto" }}>
                  {selected.families.map((family) => {
                    const title = familyTitle(family, strings.untitled);
                    return (
                      <div
                        key={family.id}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 3,
                          padding: "8px 10px",
                          borderRadius: 6,
                          background: "var(--bg-hover)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={title}>
                            {title}
                          </span>
                          <ConfigButton
                            variant="ghost"
                            size="small"
                            disabled={busy}
                            onClick={() => void unarchive([family.id])}
                          >
                            {busy ? strings.busy : strings.unarchive}
                          </ConfigButton>
                        </div>
                        <div style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
                          <span>{formatRelativeTime(new Date(family.archivedAt), locale)}</span>
                          <span>{interpolate(strings.messages, { count: family.messageCount })}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {error && <p role="alert" className="settings-general-error">{error}</p>}
              </ConfigDetailStack>
            ) : (
              <ConfigEmptyState>{strings.empty}</ConfigEmptyState>
            )}
          </ConfigDetail>
        </ConfigSplitView>
      )}
    </ConfigPanelShell>
  );
}
