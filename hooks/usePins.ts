"use client";

// [pin-fork] Client-side view of the server pin store.
//
// Pin state is owned by the server so that PC / phone / tablet agree. The hook
// loads it once on mount and then adopts whatever payload an existing response
// already carries, which is how the sidebar's lightweight 2.5s poll keeps every
// open tab in sync without a dedicated request.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  emptyPinSets,
  parsePinsPayload,
  pinSetsOf,
  pinsChanged,
  type PinKind,
  type PinSets,
} from "@/lib/pin-order";

export interface UsePins {
  /** Current pin sets, keyed by session id and by server project key. */
  sets: PinSets;
  /** Adopt a pins payload delivered alongside another response (poll, list load). */
  applyPayload: (raw: unknown) => void;
  /** Optimistic pin/unpin; the server response (or a refresh) is authoritative. */
  toggle: (kind: PinKind, key: string, pinned: boolean) => Promise<boolean>;
  /** Re-read the server state, e.g. after a failed request. */
  refresh: () => Promise<void>;
}

function withPin(sets: PinSets, kind: PinKind, key: string, pinned: boolean): PinSets {
  const source = kind === "session" ? sets.sessions : sets.projects;
  if (source.has(key) === pinned) return sets;
  const next = new Set(source);
  if (pinned) next.add(key);
  else next.delete(key);
  return kind === "session"
    ? { ...sets, sessions: next }
    : { ...sets, projects: next };
}

export function usePins(): UsePins {
  const [sets, setSets] = useState<PinSets>(emptyPinSets);
  // Guards against an in-flight refresh overwriting a newer optimistic state.
  const revisionRef = useRef(0);

  const applyPayload = useCallback((raw: unknown) => {
    const payload = parsePinsPayload(raw);
    const next = pinSetsOf(payload);
    revisionRef.current += 1;
    setSets((prev) => (pinsChanged(next, prev) ? next : prev));
  }, []);

  const refresh = useCallback(async () => {
    const revision = revisionRef.current;
    try {
      const res = await fetch("/api/pins", { cache: "no-store" });
      if (!res.ok) return;
      const payload = parsePinsPayload(await res.json());
      // A toggle that landed while this request was in flight wins.
      if (revision !== revisionRef.current) return;
      setSets((prev) => {
        const next = pinSetsOf(payload);
        return pinsChanged(next, prev) ? next : prev;
      });
    } catch {
      // Keep the last known state; the next poll or toggle retries.
    }
  }, []);

  const toggle = useCallback(async (kind: PinKind, key: string, pinned: boolean) => {
    revisionRef.current += 1;
    setSets((prev) => withPin(prev, kind, key, pinned));
    try {
      const res = await fetch("/api/pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, key, pinned }),
        cache: "no-store",
      });
      if (!res.ok) {
        await refresh();
        return false;
      }
      applyPayload(await res.json());
      return true;
    } catch {
      await refresh();
      return false;
    }
  }, [applyPayload, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sets, applyPayload, toggle, refresh };
}
