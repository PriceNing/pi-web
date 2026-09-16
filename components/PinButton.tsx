"use client";

// [pin-fork] Pin toggle for a project or a session.
//
// Two presentations:
//   variant="action" matches the row's rename/delete buttons exactly (same box,
//     same hover treatment) and follows the same reveal rule, so on desktop it
//     reads as part of that group. A pinned row keeps it visible as a marker.
//   variant="inline" is the compact glyph used inside the project dropdown rows,
//     which are themselves <button> elements and cannot host a 32px boxed button.
//
// On touch devices there is no hover, so the control stays visible; otherwise a
// phone could never reach it.
//
// Labels are local to this file instead of keys in lib/i18n/messages/*: the
// message catalogs are among the most frequently changed files upstream, and
// keeping this feature's strings self-contained keeps the fork patch small.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PinKind } from "@/lib/pin-order";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";

type LabelKey = "pinSession" | "unpinSession" | "pinProject" | "unpinProject" | "pinFailed";

const LABELS: Record<"en" | "zh-CN" | "zh-TW", Record<LabelKey, string>> = {
  en: {
    pinSession: "Pin session",
    unpinSession: "Unpin session",
    pinProject: "Pin project",
    unpinProject: "Unpin project",
    pinFailed: "Could not save the pin",
  },
  "zh-CN": {
    pinSession: "置顶会话",
    unpinSession: "取消置顶会话",
    pinProject: "置顶项目",
    unpinProject: "取消置顶项目",
    pinFailed: "置顶保存失败",
  },
  "zh-TW": {
    pinSession: "釘選工作階段",
    unpinSession: "取消釘選工作階段",
    pinProject: "釘選專案",
    unpinProject: "取消釘選專案",
    pinFailed: "釘選儲存失敗",
  },
};

// Same geometry as the rename/delete buttons in SessionItem.
const ACTION_BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  padding: 0,
  flexShrink: 0,
  background: "var(--bg-hover)",
  border: "1px solid var(--border)",
  borderRadius: 7,
  color: "var(--text-muted)",
  cursor: "pointer",
  transition: "background 0.12s, color 0.12s, border-color 0.12s",
};

// Compact variant for the 11px project dropdown rows.
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

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="17" x2="12" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

export interface PinButtonProps {
  kind: PinKind;
  /** Session id or server project key. */
  id: string;
  pinned: boolean;
  onToggle: (kind: PinKind, id: string, pinned: boolean) => Promise<boolean> | void;
  variant?: "action" | "inline";
  /**
   * "span" is required when the control sits inside another <button> (the
   * project rows in the workspace dropdown are buttons themselves).
   */
  as?: "button" | "span";
  /** Reveal rule for variant="action": show when hovered, pinned, or on touch. */
  hovered?: boolean;
}

export function PinButton({
  kind,
  id,
  pinned,
  onToggle,
  variant = "action",
  as = "button",
  hovered = false,
}: PinButtonProps) {
  const { locale } = useI18n();
  const isMobile = useIsMobile();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);
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
    // Never let the tap reach the row: selecting the session (or switching
    // project) would close the sidebar on mobile and lose the pin gesture.
    event.stopPropagation();
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    void (async () => {
      const ok = await onToggle(kind, id, !pinned);
      if (!mountedRef.current) return;
      setBusy(false);
      if (ok === false) setFailed(true);
    })();
  }, [busy, id, kind, onToggle, pinned]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.stopPropagation();
    event.preventDefault();
    handleClick(event as unknown as React.MouseEvent);
  }, [handleClick]);

  if (variant === "action" && !(isMobile || hovered || pinned)) return null;

  const strings = LABELS[locale] ?? LABELS.en;
  const label = pinned
    ? (kind === "session" ? strings.unpinSession : strings.unpinProject)
    : (kind === "session" ? strings.pinSession : strings.pinProject);
  const accent = "rgba(37,99,235,0.35)";

  const base = variant === "action" ? ACTION_BUTTON_STYLE : INLINE_BUTTON_STYLE;
  // A pinned row keeps the accent marker even when the row is not hovered.
  const style: React.CSSProperties = variant === "action"
    ? {
        ...base,
        background: hover ? "var(--bg-selected)" : "var(--bg-hover)",
        color: failed ? "#ef4444" : pinned ? "var(--accent)" : hover ? "var(--accent)" : "var(--text-muted)",
        borderColor: failed || pinned || hover ? accent : "var(--border)",
      }
    : {
        ...base,
        color: failed ? "#ef4444" : pinned ? "var(--accent)" : "var(--text-dim)",
        opacity: pinned || isMobile ? 1 : 0.7,
      };

  // A variable tag keeps this valid inside another <button> (project rows).
  const Tag = (as === "span" ? "span" : "button") as "button";

  return (
    <Tag
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...(as === "span" ? { role: "button", tabIndex: 0, onKeyDown: handleKeyDown } : {})}
      aria-pressed={pinned}
      title={failed ? strings.pinFailed : label}
      aria-label={label}
      style={style}
    >
      <PinIcon filled={pinned} />
    </Tag>
  );
}
