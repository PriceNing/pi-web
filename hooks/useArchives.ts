"use client";

// [archive-fork] Client-side view of the server archive store.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  archiveSetOf,
  archiveSetsDiffer,
  emptyArchivesPayload,
  parseArchivesPayload,
} from "@/lib/archive-order";

export interface UseArchives {
  set: ReadonlySet<string>;
  applyPayload: (raw: unknown) => void;
  toggle: (key: string, archived: boolean) => Promise<boolean>;
  refresh: () => Promise<void>;
}

export function useArchives(): UseArchives {
  const [set, setSet] = useState<ReadonlySet<string>>(() => new Set());
  const revisionRef = useRef(0);

  const applyPayload = useCallback((raw: unknown) => {
    const next = archiveSetOf(parseArchivesPayload(raw));
    revisionRef.current += 1;
    setSet((prev) => (archiveSetsDiffer(next, prev) ? next : prev));
  }, []);

  const refresh = useCallback(async () => {
    const revision = revisionRef.current;
    try {
      const res = await fetch("/api/archives", { cache: "no-store" });
      if (!res.ok) return;
      const payload = parseArchivesPayload(await res.json());
      if (revision !== revisionRef.current) return;
      setSet((prev) => {
        const next = archiveSetOf(payload);
        return archiveSetsDiffer(next, prev) ? next : prev;
      });
    } catch {
      // Keep the last known state.
    }
  }, []);

  const toggle = useCallback(async (key: string, archived: boolean) => {
    revisionRef.current += 1;
    setSet((prev) => {
      if (prev.has(key) === archived) return prev;
      const next = new Set(prev);
      if (archived) next.add(key);
      else next.delete(key);
      return next;
    });
    try {
      const res = await fetch("/api/archives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, archived }),
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

  return { set, applyPayload, toggle, refresh };
}

export { emptyArchivesPayload };
