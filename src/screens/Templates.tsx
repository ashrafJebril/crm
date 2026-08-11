import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge, type BadgeKind } from "@/components/Badge";
import { PhotoSlot } from "@/components/PhotoSlot";
import {
  IconFilter,
  IconMore,
  IconPlus,
  IconSearch,
} from "@/icons";
import {
  MEDIA_ASSETS,
  QUICK_REPLIES,
  TPL_LIBRARY,
  type TemplateCategory,
  type TemplateFull,
} from "@/data/templates-extras";
import { useFetch } from "@/api/useFetch";
import { api } from "@/api/client";
import { useToast } from "@/components/Toast";
import { Modal } from "@/components/Modal";
import { TemplateEditor } from "./templates/TemplateEditor";
import type { Template } from "@/lib/types";

type Tab = "library" | "quick" | "media";
type CategoryFilter = "ALL" | TemplateCategory;

const CATEGORY_FILTERS: CategoryFilter[] = [
  "ALL",
  "TRANSACTIONAL",
  "UTILITY",
  "MARKETING",
  "AUTHENTICATION",
];

const CATEGORY_BADGE: Record<TemplateCategory, BadgeKind> = {
  TRANSACTIONAL: "info",
  UTILITY: "",
  MARKETING: "accent",
  AUTHENTICATION: "warn",
};

// Server states include "submitted" / "failed" from Meta submission flow; map
// them to the existing badge palette so old rows still render.
const STATUS_BADGE: Record<string, BadgeKind> = {
  approved: "ok",
  pending: "warn",
  rejected: "bad",
  submitted: "warn",
  failed: "bad",
};

interface TemplatePreviewProps {
  selected: TemplateFull;
  isAr: boolean;
  onEdit: () => void;
  onDuplicate: () => void;
  busy: boolean;
}

function TemplatePreview({
  selected,
  isAr,
  onEdit,
  onDuplicate,
  busy,
}: TemplatePreviewProps) {
  const parts = selected.body.split(/(\{\{\d+\}\})/g);
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="card-h">
        <div>
          <h3 className="mono" style={{ fontSize: 13 }}>
            {selected.name}
          </h3>
          <div className="sub">
            {selected.category} · {selected.lang.toUpperCase()}
          </div>
        </div>
        <Badge kind={STATUS_BADGE[selected.status] ?? ""} dot>
          {selected.status}
        </Badge>
      </div>

      <div style={{ padding: 18, background: "var(--bg-2)", flex: 1, overflowY: "auto" }}>
        <div
          style={{
            background:
              "linear-gradient(180deg, oklch(0.36 0.04 152) 0%, oklch(0.18 0.02 152) 100%)",
            borderRadius: 18,
            padding: 14,
            position: "relative",
            minHeight: 320,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              paddingBottom: 10,
              borderBottom: "1px solid oklch(1 0 0 / 0.12)",
            }}
          >
            <Avatar name="Samemha" size="sm" />
            <div style={{ flex: 1 }}>
              <div style={{ color: "white", fontSize: 12, fontWeight: 500 }}>
                Samemha
              </div>
              <div
                style={{
                  color: "oklch(1 0 0 / 0.6)",
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {isAr ? "أعمال · موثّق" : "Business · verified"}
              </div>
            </div>
            <span style={{ color: "var(--accent)", fontSize: 10 }}>●</span>
          </div>
          <div
            style={{ marginTop: 14 }}
            dir={selected.lang === "ar" ? "rtl" : "ltr"}
          >
            <div
              style={{
                background: "white",
                color: "#1a1a1a",
                padding: "10px 12px",
                borderRadius: "12px 12px 12px 4px",
                fontSize: 13,
                lineHeight: 1.5,
                maxWidth: 280,
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }}
            >
              {parts.map((part, i) =>
                /\{\{\d+\}\}/.test(part) ? (
                  <span
                    key={i}
                    style={{
                      background: "oklch(0.92 0.08 150)",
                      padding: "0 4px",
                      borderRadius: 3,
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                    }}
                  >
                    {part}
                  </span>
                ) : (
                  <span key={i}>{part}</span>
                ),
              )}
            </div>
            {selected.buttons.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                  marginTop: 6,
                  maxWidth: 280,
                }}
              >
                {selected.buttons.map((b, i) => (
                  <div
                    key={i}
                    style={{
                      background: "oklch(0.32 0.03 152)",
                      color: "oklch(0.9 0.06 152)",
                      padding: "8px 12px",
                      borderRadius: 8,
                      textAlign: "center",
                      fontSize: 12,
                      fontWeight: 500,
                      border: "1px solid oklch(1 0 0 / 0.08)",
                    }}
                  >
                    {b}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        style={{
          padding: 14,
          borderTop: "1px solid var(--line-soft)",
          display: "flex",
          gap: 6,
        }}
      >
        <button className="btn sm" style={{ flex: 1 }} onClick={onDuplicate} disabled={busy}>
          {isAr ? "نسخ" : "Duplicate"}
        </button>
        <button
          className="btn sm primary"
          style={{ flex: 1 }}
          onClick={onEdit}
          disabled={busy}
        >
          {isAr ? "تعديل" : "Edit"}
        </button>
      </div>
    </div>
  );
}

// Server hands templates back with body/buttons populated (after CRUD wiring).
// Seed/library rows from before that change may still have empty body — fall
// back to the static TPL_LIBRARY by name so legacy rows still preview.
function toTemplateFull(t: Template): TemplateFull {
  const match = TPL_LIBRARY.find((x) => x.name === t.name);
  const category: TemplateCategory =
    t.category === "TRANSACTIONAL" ||
    t.category === "UTILITY" ||
    t.category === "MARKETING" ||
    t.category === "AUTHENTICATION"
      ? t.category
      : "UTILITY";

  // API stores buttons as a JSON string of objects. Extract the visible labels
  // for the preview; the editor parses the same string back into full objects.
  let apiButtonLabels: string[] = [];
  if (t.buttons) {
    try {
      const parsed = JSON.parse(t.buttons);
      if (Array.isArray(parsed)) {
        apiButtonLabels = parsed
          .map((b) => (b && typeof b.text === "string" ? b.text : null))
          .filter((x): x is string => x !== null);
      }
    } catch {
      apiButtonLabels = [];
    }
  }

  const status: TemplateFull["status"] =
    t.status === "approved" || t.status === "pending" || t.status === "rejected"
      ? t.status
      : t.status === "failed"
        ? "rejected"
        : "pending";

  return {
    id: t.id,
    name: t.name,
    lang: t.lang,
    category,
    status,
    uses: t.uses,
    updated: match?.updated ?? "—",
    body: t.body || match?.body || "",
    buttons: apiButtonLabels.length > 0 ? apiButtonLabels : (match?.buttons ?? []),
  };
}

function TemplatesImpl() {
  const { t } = useTweaks();
  const { toast } = useToast();
  const tx = makeTx(t.lang);
  const isAr = t.lang === "ar";

  const [tab, setTab] = useState<Tab>("library");
  const [filter, setFilter] = useState<CategoryFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState<string>("");
  const [editor, setEditor] = useState<
    | null
    | { mode: "create" }
    | { mode: "edit"; template: Template }
    | { mode: "create"; initial: Template }
  >(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Template | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const {
    data: templates,
    loading,
    error,
    refetch,
  } = useFetch<Template[]>("/templates");

  const allFull: TemplateFull[] = useMemo(
    () => (templates ?? []).map(toTemplateFull),
    [templates],
  );

  const list = useMemo(
    () =>
      allFull
        .filter((x) => filter === "ALL" || x.category === filter)
        .filter(
          (x) => !search || x.name.toLowerCase().includes(search.toLowerCase()),
        ),
    [allFull, filter, search],
  );

  const selected: TemplateFull | null =
    allFull.find((x) => x.id === selectedId) ?? allFull[0] ?? null;
  const selectedRaw =
    (templates ?? []).find((x) => x.id === selected?.id) ?? null;

  const counts = useMemo(() => {
    let approved = 0;
    let pending = 0;
    let rejected = 0;
    for (const tpl of allFull) {
      if (tpl.status === "approved") approved++;
      else if (tpl.status === "pending") pending++;
      else if (tpl.status === "rejected") rejected++;
    }
    return { approved, pending, rejected };
  }, [allFull]);

  // Close the row context menu on outside click.
  useEffect(() => {
    if (!menuFor) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuFor(null);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuFor]);

  const handleDuplicate = async (tpl: Template) => {
    setPending(true);
    try {
      const created = await api.post<Template>(`/templates/${tpl.id}/duplicate`);
      refetch();
      setSelectedId(created.id);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Duplicate failed", "error");
    } finally {
      setPending(false);
      setMenuFor(null);
    }
  };

  const handleDelete = async (tpl: Template) => {
    setPending(true);
    try {
      await api.delete(`/templates/${tpl.id}`);
      if (selectedId === tpl.id) setSelectedId(null);
      refetch();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
    } finally {
      setPending(false);
      setConfirmDelete(null);
      setMenuFor(null);
    }
  };

  return (
    <div
      data-screen-label="Templates"
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      <PageHeader
        title={tx("Templates", "القوالب")}
        subtitle={tx(
          "Pre-approved WhatsApp templates and quick replies for your team",
          "قوالب رسائل واتساب المعتمدة وردود سريعة",
        )}
        actions={
          <>
            <button className="btn ghost">
              <IconFilter w={14} />
              {tx("Filter", "تصفية")}
            </button>
            <button
              className="btn primary"
              onClick={() => setEditor({ mode: "create" })}
            >
              <IconPlus w={14} />
              {tx("New template", "قالب جديد")}
            </button>
          </>
        }
      />

      <div className="tabs">
        <div
          className={`tab ${tab === "library" ? "active" : ""}`}
          onClick={() => setTab("library")}
        >
          {tx("Library", "المكتبة")}{" "}
          <span className="count">{allFull.length}</span>
        </div>
        <div
          className={`tab ${tab === "quick" ? "active" : ""}`}
          onClick={() => setTab("quick")}
        >
          {tx("Quick replies", "ردود سريعة")}{" "}
          <span className="count">{QUICK_REPLIES.length}</span>
        </div>
        <div
          className={`tab ${tab === "media" ? "active" : ""}`}
          onClick={() => setTab("media")}
        >
          {tx("Media", "الوسائط")} <span className="count">{MEDIA_ASSETS.length}</span>
        </div>
      </div>

      {tab === "library" && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 380px",
            gap: 16,
            padding: 20,
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div
            className="card"
            style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            {/* filter chips */}
            <div
              style={{
                display: "flex",
                gap: 8,
                padding: 14,
                borderBottom: "1px solid var(--line-soft)",
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {CATEGORY_FILTERS.map((c) => (
                <button
                  key={c}
                  onClick={() => setFilter(c)}
                  className="chip"
                  style={{
                    background:
                      filter === c ? "var(--accent-soft)" : "var(--bg-2)",
                    color: filter === c ? "var(--accent)" : "var(--ink-1)",
                    border: `1px solid ${
                      filter === c ? "var(--accent-ring)" : "var(--line-soft)"
                    }`,
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    padding: "4px 10px",
                    borderRadius: 999,
                    cursor: "pointer",
                    letterSpacing: 0.04,
                  }}
                >
                  {c}
                </button>
              ))}
              <div style={{ flex: 1 }} />
              <div className="search" style={{ width: 220, padding: "4px 10px" }}>
                <IconSearch w={12} />
                <input
                  placeholder={tx("Search by name…", "ابحث…")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            <div style={{ overflow: "auto", flex: 1 }}>
              {loading && (
                <div
                  className="muted"
                  style={{
                    padding: "16px 14px",
                    fontSize: 12,
                    opacity: 0.7,
                    animation: "pulse 1.2s ease-in-out infinite",
                  }}
                >
                  {tx("loading…", "جارٍ التحميل…")}
                </div>
              )}
              {error && !loading && (
                <div
                  style={{
                    padding: "12px 14px",
                    color: "var(--bad)",
                    fontSize: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <span>{error}</span>
                  <button className="btn sm" onClick={refetch}>
                    {tx("Retry", "إعادة")}
                  </button>
                </div>
              )}
              {!loading && !error && (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{tx("Name", "الاسم")}</th>
                      <th>{tx("Category", "الفئة")}</th>
                      <th>{tx("Lang", "اللغة")}</th>
                      <th>{tx("Status", "الحالة")}</th>
                      <th style={{ textAlign: "end" }}>
                        {tx("Uses", "الاستخدام")}
                      </th>
                      <th>{tx("Updated", "آخر تحديث")}</th>
                      <th style={{ width: 30 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((tpl) => {
                      const raw =
                        (templates ?? []).find((x) => x.id === tpl.id) ?? null;
                      return (
                        <tr
                          key={tpl.id}
                          className={selected?.id === tpl.id ? "selected" : ""}
                          onClick={() => setSelectedId(tpl.id)}
                          style={{ cursor: "pointer" }}
                        >
                          <td className="mono" style={{ fontWeight: 500, fontSize: 12 }}>
                            {tpl.name}
                          </td>
                          <td>
                            <Badge kind={CATEGORY_BADGE[tpl.category]}>
                              {tpl.category}
                            </Badge>
                          </td>
                          <td
                            className="mono"
                            style={{ fontSize: 11, color: "var(--ink-2)" }}
                          >
                            {tpl.lang}
                          </td>
                          <td>
                            <Badge kind={STATUS_BADGE[tpl.status] ?? ""} dot>
                              {tpl.status}
                            </Badge>
                          </td>
                          <td className="mono" style={{ textAlign: "end", fontSize: 12 }}>
                            {tpl.uses.toLocaleString()}
                          </td>
                          <td
                            className="mono"
                            style={{ fontSize: 11, color: "var(--ink-3)" }}
                          >
                            {tpl.updated}
                          </td>
                          <td style={{ position: "relative" }}>
                            <button
                              aria-label="Row menu"
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenuFor(menuFor === tpl.id ? null : tpl.id);
                              }}
                              style={{
                                background: "transparent",
                                border: 0,
                                cursor: "pointer",
                                color: "var(--ink-2)",
                                padding: 4,
                                display: "grid",
                                placeItems: "center",
                              }}
                            >
                              <IconMore w={14} />
                            </button>
                            {menuFor === tpl.id && raw && (
                              <div
                                ref={menuRef}
                                onClick={(e) => e.stopPropagation()}
                                style={{
                                  position: "absolute",
                                  right: 8,
                                  top: "100%",
                                  marginTop: 4,
                                  background: "var(--bg-1)",
                                  border: "1px solid var(--line)",
                                  borderRadius: "var(--r)",
                                  boxShadow: "0 6px 24px rgba(0,0,0,0.25)",
                                  minWidth: 140,
                                  zIndex: 50,
                                  overflow: "hidden",
                                }}
                              >
                                <RowMenuItem
                                  label={tx("Edit", "تعديل")}
                                  onClick={() => {
                                    setMenuFor(null);
                                    setEditor({ mode: "edit", template: raw });
                                  }}
                                />
                                <RowMenuItem
                                  label={tx("Duplicate", "نسخ")}
                                  disabled={pending}
                                  onClick={() => void handleDuplicate(raw)}
                                />
                                <RowMenuItem
                                  label={tx("Delete", "حذف")}
                                  destructive
                                  onClick={() => {
                                    setMenuFor(null);
                                    setConfirmDelete(raw);
                                  }}
                                />
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div
              style={{
                padding: "10px 14px",
                borderTop: "1px solid var(--line-soft)",
                color: "var(--ink-3)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span>
                {list.length} of {allFull.length}
              </span>
              <span>·</span>
              <span style={{ color: "var(--ok)" }}>● {counts.approved} approved</span>
              <span style={{ color: "var(--warn)" }}>● {counts.pending} pending</span>
              <span style={{ color: "var(--bad)" }}>● {counts.rejected} rejected</span>
            </div>
          </div>

          {selected && selectedRaw ? (
            <TemplatePreview
              selected={selected}
              isAr={isAr}
              busy={pending}
              onEdit={() => setEditor({ mode: "edit", template: selectedRaw })}
              onDuplicate={() => void handleDuplicate(selectedRaw)}
            />
          ) : (
            <div
              className="card"
              style={{
                display: "grid",
                placeItems: "center",
                color: "var(--ink-3)",
                fontSize: 12,
              }}
            >
              {loading
                ? tx("loading…", "جارٍ التحميل…")
                : tx("No template selected", "لم يُختر قالب")}
            </div>
          )}
        </div>
      )}

      {tab === "quick" && (
        <div style={{ padding: 20 }}>
          <div className="card">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{tx("Shortcut", "الاختصار")}</th>
                  <th>{tx("Message", "الرسالة")}</th>
                  <th style={{ textAlign: "end" }}>{tx("Used", "الاستخدام")}</th>
                  <th style={{ width: 60 }}></th>
                </tr>
              </thead>
              <tbody>
                {QUICK_REPLIES.map((q) => (
                  <tr key={q.id}>
                    <td
                      className="mono"
                      style={{ fontWeight: 500, color: "var(--accent)" }}
                    >
                      {q.short}
                    </td>
                    <td style={{ color: "var(--ink-1)" }}>{q.body}</td>
                    <td
                      className="mono"
                      style={{
                        textAlign: "end",
                        color: "var(--ink-3)",
                        fontSize: 12,
                      }}
                    >
                      {q.used}
                    </td>
                    <td>
                      <IconMore w={14} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === "media" && (
        <div
          style={{
            padding: 20,
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr)",
            gap: 12,
          }}
        >
          {MEDIA_ASSETS.map((m) => (
            <div key={m.label} className="card" style={{ padding: 12 }}>
              <PhotoSlot label={m.label} h={120} />
              <div
                style={{
                  marginTop: 10,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
              >
                <div className="mono" style={{ fontSize: 11 }}>
                  {m.label}.jpg
                </div>
                <span
                  className="mono"
                  style={{ fontSize: 10, color: "var(--ink-3)" }}
                >
                  {m.size}KB
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {editor && (
        <TemplateEditor
          lang={t.lang}
          mode={editor.mode}
          initial={
            editor.mode === "edit"
              ? editor.template
              : "initial" in editor
                ? editor.initial
                : null
          }
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            refetch();
            setSelectedId(saved.id);
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDelete
          name={confirmDelete.name}
          lang={t.lang}
          busy={pending}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void handleDelete(confirmDelete)}
        />
      )}
    </div>
  );
}

function RowMenuItem({
  label,
  onClick,
  destructive,
  disabled,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "block",
        width: "100%",
        padding: "8px 12px",
        background: "transparent",
        border: 0,
        textAlign: "start",
        fontSize: 12,
        color: destructive ? "var(--bad)" : "var(--ink-1)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {label}
    </button>
  );
}

function ConfirmDelete({
  name,
  lang,
  busy,
  onCancel,
  onConfirm,
}: {
  name: string;
  lang: "en" | "ar";
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ar = lang === "ar";
  return (
    <Modal onClose={onCancel} width={400} zIndex={110} label="Delete template">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 15, color: "var(--ink)" }}>
          {ar ? "حذف القالب؟" : "Delete template?"}
        </h3>
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)" }}>
          {ar
            ? `سيتم حذف "${name}" بشكل دائم.`
            : `"${name}" will be permanently deleted.`}
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "1px solid var(--line)",
              borderRadius: "var(--r)",
              color: "var(--ink-2)",
              cursor: "pointer",
            }}
          >
            {ar ? "إلغاء" : "Cancel"}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            style={{
              padding: "8px 14px",
              background: "var(--bad)",
              border: 0,
              borderRadius: "var(--r)",
              color: "white",
              cursor: "pointer",
            }}
          >
            {busy ? (ar ? "جارٍ الحذف…" : "Deleting…") : ar ? "حذف" : "Delete"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const Templates = memo(TemplatesImpl);
export default Templates;
