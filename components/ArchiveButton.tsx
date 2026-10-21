"use client";

// [archive-fork] Archive toggle for a project row.
//
// Compact glyph matching PinButton's inline variant so it can sit inside the
// project dropdown, which is itself a <button>. Labels stay in this file to
// avoid touching the hot i18n catalogs.

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

type LabelKey = "archiveProject" | "unarchiveProject" | "archiveFailed";

const LABELS: Record<"en" | "zh-CN" | "zh-TW", Record<LabelKey, string>> = {
  en: {
    archiveProject: "Archive project",
    unarchiveProject: "Unarchive project",
    archiveFailed: "Could not save the archive",
  },
  "zh-CN": {
    archiveProject: "归档项目",
    unarchiveProject: "取消归档",
    archiveFailed: "归档保存失败",
  },
  "zh-TW": {
    archiveProject: "封存專案",
    unarchiveProject: "取消封存",
    archiveFailed: "封存儲存失敗",
  },
};

const INLINE_BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  padding: 0,
  flexShrink: 0,
  background: "none",
  border: "none",
  color: "var(--text-dim)",
  cursor: "pointer",
  transition: "color 0.12s",
};

function ArchiveIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

export interface ArchiveButtonProps {
  id: string;
  archived: boolean;
  onToggle: (id: string, archived: boolean) => Promise<boolean> | void;
  as?: "button" | "span";
}

export function ArchiveButton({
  id,
  archived,
  onToggle,
  as = "button",
}: ArchiveButtonProps) {
  const { locale } = useI18n();
  const isMobile = useIsMobile();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => setFailed(false), 1600);
    return () => clearTimeout(timer);
  }, [failed]);

  const handleClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    void (async () => {
      const ok = await onToggle(id, !archived);
      if (!mountedRef.current) return;
      setBusy(false);
      if (ok === false) setFailed(true);
    })();
  }, [archived, busy, id, onToggle]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.stopPropagation();
    event.preventDefault();
    handleClick(event as unknown as React.MouseEvent);
  }, [handleClick]);

  const strings = LABELS[locale] ?? LABELS.en;
  const label = archived ? strings.unarchiveProject : strings.archiveProject;
  const style: React.CSSProperties = {
    ...INLINE_BUTTON_STYLE,
    color: failed ? "#ef4444" : archived ? "var(--accent)" : "var(--text-dim)",
    opacity: archived || isMobile ? 1 : 0.7,
  };
  const Tag = (as === "span" ? "span" : "button") as "button";

  return (
    <Tag
      onClick={handleClick}
      {...(as === "span" ? { role: "button", tabIndex: 0, onKeyDown: handleKeyDown } : {})}
      aria-pressed={archived}
      title={failed ? strings.archiveFailed : label}
      aria-label={label}
      style={style}
    >
      <ArchiveIcon filled={archived} />
    </Tag>
  );
}
