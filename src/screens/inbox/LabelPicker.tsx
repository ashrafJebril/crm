import { useRef, useState } from "react";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { makeTx } from "@/lib/tx";
import type { ConversationLabel, Lang } from "@/lib/types";

export const LABEL_COLOR_VAR: Record<ConversationLabel["color"], string> = {
  ink: "var(--ink-3)",
  info: "var(--info)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  accent: "var(--accent)",
  human: "var(--human)",
};
const COLORS = Object.keys(LABEL_COLOR_VAR) as ConversationLabel["color"][];

export function LabelPicker({
  conversationId,
  labelIds,
  lang,
  disabled,
  disabledReason,
  onChanged,
  onError,
}: {
  conversationId: string;
  labelIds: string[];
  lang: Lang;
  disabled?: boolean;
  disabledReason?: string;
  onChanged: () => Promise<unknown> | void;
  onError: (msg: string) => void;
}) {
  const tx = makeTx(lang);
  const [open, setOpen] = useState(false);
  const labelsQ = useFetch<ConversationLabel[]>(open ? "/conversation-labels" : null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<ConversationLabel["color"]>("info");
  const labels = labelsQ.data ?? [];
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closePanel = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const colorName: Record<ConversationLabel["color"], string> = {
    ink: tx("Grey", "رمادي"),
    info: tx("Blue", "أزرق"),
    ok: tx("Green", "أخضر"),
    warn: tx("Amber", "كهرماني"),
    bad: tx("Red", "أحمر"),
    accent: tx("Accent", "لون التمييز"),
    human: tx("Violet", "بنفسجي"),
  };

  async function save(next: string[]) {
    setBusy(true);
    try {
      await api.put(`/conversations/${conversationId}/labels`, { labelIds: next });
      await onChanged();
    } catch {
      onError(tx("Couldn't update labels", "تعذّر تحديث الوسوم"));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      let made: ConversationLabel;
      try {
        made = await api.post<ConversationLabel>("/conversation-labels", { name: n, color });
      } catch (e) {
        onError(
          e instanceof ApiError && e.status === 409
            ? tx("A label with that name already exists", "يوجد وسم بهذا الاسم بالفعل")
            : tx("Couldn't create label", "تعذّر إنشاء الوسم"),
        );
        return;
      }
      setName("");
      await labelsQ.refetch();
      try {
        await api.put(`/conversations/${conversationId}/labels`, {
          labelIds: [...labelIds, made.id],
        });
        await onChanged();
      } catch {
        onError(
          tx(
            "Label created, but couldn't attach it",
            "تم إنشاء الوسم، لكن تعذّر إرفاقه بالمحادثة",
          ),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <span title={disabled ? disabledReason : undefined} style={{ display: "inline-flex" }}>
      <button
        ref={triggerRef}
        className="btn"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {tx("Labels", "الوسوم")}
        {labelIds.length > 0 ? ` (${labelIds.length})` : ""}
      </button>
      </span>
      {open && !disabled && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div
            role="dialog"
            aria-label={tx("Labels", "الوسوم")}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                closePanel();
              }
            }}
            style={{
              position: "absolute",
              insetInlineEnd: 0,
              top: "calc(100% + 4px)",
              zIndex: 41,
              minWidth: 230,
              maxHeight: 340,
              overflowY: "auto",
              padding: 8,
              background: "var(--bg-1)",
              border: "1px solid var(--line-soft)",
              borderRadius: 8,
              boxShadow: "0 8px 24px rgba(0,0,0,.18)",
            }}
          >
            {labels.length === 0 && !labelsQ.loading && (
              <div style={{ fontSize: 12, color: "var(--ink-3)", padding: 4 }}>
                {tx("No labels yet", "لا توجد وسوم بعد")}
              </div>
            )}
            {labels.map((l) => {
              const checked = labelIds.includes(l.id);
              return (
                <label
                  key={l.id}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", cursor: "pointer", fontSize: 13 }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={busy}
                    onChange={() =>
                      save(checked ? labelIds.filter((x) => x !== l.id) : [...labelIds, l.id])
                    }
                  />
                  <span style={{ width: 10, height: 10, borderRadius: 99, background: LABEL_COLOR_VAR[l.color] }} />
                  <span style={{ flex: 1 }}>{l.name}</span>
                </label>
              );
            })}
            <div style={{ borderTop: "1px solid var(--line-soft)", marginTop: 6, paddingTop: 8 }}>
              <input
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
                placeholder={tx("New label name", "اسم وسم جديد")}
                aria-label={tx("New label name", "اسم وسم جديد")}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={colorName[c]}
                    title={colorName[c]}
                    aria-pressed={color === c}
                    onClick={() => setColor(c)}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 99,
                      background: LABEL_COLOR_VAR[c],
                      border: color === c ? "2px solid var(--ink)" : "2px solid transparent",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  />
                ))}
                <button
                  className="btn sm"
                  style={{ marginInlineStart: "auto" }}
                  disabled={!name.trim() || busy}
                  onClick={create}
                >
                  {tx("Add", "إضافة")}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
