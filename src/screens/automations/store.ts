// UI-only persistence for Automations. This is the one file to swap for
// useFetch/useMutation once the backend exists; the page and builder only
// see the hook's return shape.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/auth/context";
import type { Automation } from "@/lib/automations";

export const storageKey = (workspaceId: string | null): string =>
  `tkana.automations.${workspaceId ?? "local"}`;

export function loadAutomations(storage: Pick<Storage, "getItem">, key: string): Automation[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Automation[]) : [];
  } catch {
    return [];
  }
}

export function saveAutomations(
  storage: Pick<Storage, "setItem">,
  key: string,
  list: Automation[],
): boolean {
  try {
    storage.setItem(key, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const browserStorage = (): Storage | null =>
  typeof localStorage === "undefined" ? null : localStorage;

export function useAutomationsStore() {
  const { activeWorkspace } = useAuth();
  const key = storageKey(activeWorkspace?.id ?? null);
  const [list, setList] = useState<Automation[]>(() => {
    const s = browserStorage();
    return s ? loadAutomations(s, key) : [];
  });

  // Re-read when the workspace changes (multi-workspace users switch in the Topbar).
  useEffect(() => {
    const s = browserStorage();
    setList(s ? loadAutomations(s, key) : []);
  }, [key]);

  const persist = useCallback(
    (next: Automation[]) => {
      setList(next);
      const s = browserStorage();
      if (s) saveAutomations(s, key, next);
    },
    [key],
  );

  const save = useCallback(
    (a: Automation) => {
      const stamped = { ...a, updatedAt: new Date().toISOString() };
      const idx = list.findIndex((x) => x.id === a.id);
      const next = idx === -1 ? [stamped, ...list] : list.map((x) => (x.id === a.id ? stamped : x));
      persist(next);
    },
    [list, persist],
  );

  const remove = useCallback(
    (id: string) => persist(list.filter((x) => x.id !== id)),
    [list, persist],
  );

  const setEnabled = useCallback(
    (id: string, on: boolean) =>
      persist(list.map((x) => (x.id === id ? { ...x, enabled: on } : x))),
    [list, persist],
  );

  const get = useCallback((id: string) => list.find((x) => x.id === id), [list]);

  return useMemo(() => ({ list, get, save, remove, setEnabled }), [list, get, save, remove, setEnabled]);
}
