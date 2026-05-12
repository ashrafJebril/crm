import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/auth/context";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { IconCheck, IconPlus, IconChevDown } from "@/icons";

/**
 * Top-bar dropdown showing the active workspace name. Click to:
 *   - switch between workspaces the user belongs to
 *   - create a new workspace (and switch into it)
 */
export function WorkspaceSwitcher() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { workspaces, activeWorkspace, switchWorkspace, createWorkspace } = useAuth();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on click-outside / Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const reset = useCallback(() => {
    setCreating(false);
    setNewName("");
    setError(null);
  }, []);

  const onSwitch = async (workspaceId: string) => {
    if (workspaceId === activeWorkspace?.id) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await switchWorkspace(workspaceId);
      setOpen(false);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Switch failed");
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await createWorkspace(name);
      await switchWorkspace(ws.id);
      setOpen(false);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setBusy(false);
    }
  };

  if (!activeWorkspace) return null;

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          fontSize: 12,
          color: "var(--ink-2)",
          padding: "4px 8px 4px 10px",
          borderRadius: 999,
          border: "1px solid var(--line-soft)",
          background: open ? "var(--bg-2)" : "var(--bg-1)",
          fontWeight: 500,
          fontFamily: "inherit",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer",
          maxWidth: 220,
        }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span
          style={{
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {activeWorkspace.name}
        </span>
        <IconChevDown w={11} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            insetInlineEnd: 0,
            minWidth: 240,
            maxWidth: 320,
            background: "var(--bg-elev)",
            border: "1px solid var(--line-soft)",
            borderRadius: "var(--r)",
            boxShadow: "var(--shadow-lg)",
            padding: 6,
            zIndex: 50,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 10,
              color: "var(--ink-3)",
              textTransform: "uppercase",
              letterSpacing: 0.06,
              padding: "6px 8px 2px",
            }}
          >
            {tx("Switch workspace", "تبديل مساحة العمل")}
          </div>

          {workspaces.map((w) => {
            const active = w.id === activeWorkspace.id;
            return (
              <button
                key={w.id}
                type="button"
                role="menuitem"
                onClick={() => onSwitch(w.id)}
                disabled={busy}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  width: "100%",
                  textAlign: "start",
                  background: active ? "var(--accent-soft)" : "transparent",
                  border: 0,
                  borderRadius: "var(--r-sm, 6px)",
                  cursor: "pointer",
                  color: "var(--ink)",
                  fontFamily: "inherit",
                  fontSize: 13,
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = "var(--bg-2)";
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 500,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {w.name}
                  </div>
                  <div
                    className="mono"
                    style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 1 }}
                  >
                    {w.role} · {w.plan}
                  </div>
                </div>
                {active && (
                  <span style={{ color: "var(--accent)", display: "inline-flex" }}>
                    <IconCheck w={13} />
                  </span>
                )}
              </button>
            );
          })}

          <div
            style={{
              height: 1,
              background: "var(--line-soft)",
              margin: "4px 0",
            }}
          />

          {creating ? (
            <div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                type="text"
                autoFocus
                placeholder={tx("Workspace name", "اسم مساحة العمل")}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onCreate();
                  if (e.key === "Escape") reset();
                }}
                disabled={busy}
                style={{
                  width: "100%",
                  height: 32,
                  padding: "0 10px",
                  background: "var(--bg)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r-sm, 6px)",
                  color: "var(--ink)",
                  fontSize: 13,
                  fontFamily: "inherit",
                  outline: "none",
                }}
              />
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={reset}
                  disabled={busy}
                >
                  {tx("Cancel", "إلغاء")}
                </button>
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={onCreate}
                  disabled={busy || newName.trim().length === 0}
                >
                  {busy ? tx("Creating…", "جارٍ…") : tx("Create", "إنشاء")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => setCreating(true)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                width: "100%",
                textAlign: "start",
                background: "transparent",
                border: 0,
                borderRadius: "var(--r-sm, 6px)",
                cursor: "pointer",
                color: "var(--ink-2)",
                fontFamily: "inherit",
                fontSize: 13,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "transparent";
              }}
            >
              <IconPlus w={12} />
              <span>{tx("Create new workspace", "إنشاء مساحة عمل جديدة")}</span>
            </button>
          )}

          {error && (
            <div
              style={{
                margin: "4px 6px 2px",
                padding: "6px 8px",
                fontSize: 11,
                color: "var(--bad)",
                background: "oklch(0.7 0.22 24 / 0.12)",
                border: "1px solid oklch(0.7 0.22 24 / 0.35)",
                borderRadius: "var(--r-sm, 6px)",
              }}
            >
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
