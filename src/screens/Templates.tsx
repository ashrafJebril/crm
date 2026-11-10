import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge, type BadgeKind } from "@/components/Badge";
import {
  IconFilter,
  IconMore,
  IconPlus,
  IconSearch,
} from "@/icons";
import {
  QUICK_REPLIES,
  TPL_LIBRARY,
  type TemplateCategory,
  type TemplateFull,
} from "@/data/templates-extras";
import { useFetch } from "@/api/useFetch";
import { api } from "@/api/client";
import { useToast } from "@/components/Toast";
import { usePermissions, NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { Modal } from "@/components/Modal";
import { TemplateEditor } from "./templates/TemplateEditor";
import { GalleryTab } from "./templates/GalleryTab";
import { WhatsAppGate, useWhatsAppConnection } from "@/components/WhatsAppGate";
import { gatedTitle } from "@/components/whatsAppGateCopy";
import type { Template } from "@/lib/types";
import { templateQualityCell, templateStatusView, toFullStatus } from "./channels/health/healthModel";
import { SourceMark, fmtWhen } from "./channels/health/healthUi";
import { TemplateHealthSheet } from "./templates/TemplateHealthSheet";

type Tab = "library" | "quick" | "gallery";
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
  // Neutral, deliberately not "ok": a local template cannot be sent.
  local: "",
  // SP-14: Meta paused (low quality) or disabled the template; neither can be sent.
  paused: "warn",
  disabled: "bad",
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
          {templateStatusView(selected.status, makeTx(isAr ? "ar" : "en")).label}
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

  // "local", "paused" and "disabled" must pass through, not collapse to
  // "pending": none of them can be sent as-is (SP-14 stopped hiding pauses).
  const status: TemplateFull["status"] = toFullStatus(t.status);

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
  const { can } = usePermissions();
  const canDeleteTpl = can("templates.delete");
  const canCreateTpl = can("templates.create");
  const canViewTpl = can("templates.view");
  // SP-13: one banner, and submitting to Meta is disabled while WhatsApp isn't connected.
  const { connected } = useWhatsAppConnection();
  const createGate = gatedTitle("template.create", connected, tx);
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
  const [healthFor, setHealthFor] = useState<Template | null>(null);
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
    let local = 0;
    let paused = 0;
    let disabled = 0;
    for (const tpl of allFull) {
      if (tpl.status === "approved") approved++;
      else if (tpl.status === "pending") pending++;
      else if (tpl.status === "rejected") rejected++;
      else if (tpl.status === "local") local++;
      else if (tpl.status === "paused") paused++;
      else if (tpl.status === "disabled") disabled++;
    }
    return { approved, pending, rejected, local, paused, disabled };
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
            {canCreateTpl && (
              <button
                className="btn primary"
                disabled={!!createGate}
                title={createGate ?? undefined}
                onClick={() => setEditor({ mode: "create" })}
              >
                <IconPlus w={14} />
                {tx("New template", "قالب جديد")}
              </button>
            )}
          </>
        }
      />

      {connected === false && (
        <div style={{ padding: "0 20px 12px" }}>
          <WhatsAppGate connected={connected} tx={tx} />
        </div>
      )}

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
          className={`tab ${tab === "gallery" ? "active" : ""}`}
          onClick={() => setTab("gallery")}
        >
          {tx("Gallery", "المعرض")}
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
                      <th>{tx("Quality", "الجودة")}</th>
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
                              {templateStatusView(tpl.status, tx).label}
                            </Badge>
                          </td>
                          <td>
                            <QualityBadge row={raw} tx={tx} />
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
                                {canViewTpl && (
                                  <RowMenuItem
                                    label={tx("Health", "الصحة")}
                                    onClick={() => {
                                      setMenuFor(null);
                                      setHealthFor(raw);
                                    }}
                                  />
                                )}
                                <RowMenuItem
                                  label={tx("Duplicate", "نسخ")}
                                  disabled={pending}
                                  onClick={() => void handleDuplicate(raw)}
                                />
                                <RowMenuItem
                                  label={tx("Delete", "حذف")}
                                  destructive
                                  disabled={!canDeleteTpl}
                                  title={canDeleteTpl ? undefined : tx(NO_PERMISSION_EN, NO_PERMISSION_AR)}
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
                {tx(`${list.length} of ${allFull.length}`, `${list.length} من ${allFull.length}`)}
              </span>
              <span>·</span>
              <span style={{ color: "var(--ok)" }}>● {tx(`${counts.approved} approved`, `${counts.approved} معتمد`)}</span>
              <span style={{ color: "var(--warn)" }}>● {tx(`${counts.pending} pending`, `${counts.pending} قيد المراجعة`)}</span>
              <span style={{ color: "var(--bad)" }}>● {tx(`${counts.rejected} rejected`, `${counts.rejected} مرفوض`)}</span>
              {counts.paused > 0 ? (
                <span style={{ color: "var(--warn)" }} title={tx("Meta paused these for low quality — they can't be sent", "أوقفتها Meta مؤقتًا لانخفاض جودتها — لا يمكن إرسالها")}>
                  ● {tx(`${counts.paused} paused`, `${counts.paused} متوقف مؤقتًا`)}
                </span>
              ) : null}
              {counts.disabled > 0 ? (
                <span style={{ color: "var(--bad)" }} title={tx("Meta disabled these — they can't be sent", "عطّلتها Meta — لا يمكن إرسالها")}>
                  ● {tx(`${counts.disabled} disabled`, `${counts.disabled} معطّل`)}
                </span>
              ) : null}
              {counts.local > 0 ? (
                <span style={{ color: "var(--ink-3)" }} title={tx("Not submitted to Meta — cannot be sent", "لم يُرسل إلى Meta — لا يمكن إرساله")}>
                  ● {tx(`${counts.local} local only`, `${counts.local} محلي فقط`)}
                </span>
              ) : null}
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

      {tab === "gallery" && <GalleryTab tx={tx} />}

      {editor && (
        <TemplateEditor
          lang={t.lang}
          connected={connected}
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

      {healthFor && canViewTpl && (
        <TemplateHealthSheet templateId={healthFor.id} templateName={healthFor.name} onClose={() => setHealthFor(null)} />
      )}
    </div>
  );
}

/**
 * SP-14 template quality; null (no provider value) reads as a muted Unknown,
 * never green. Final review M5: a score from the list just read shows its
 * Zernio source mark and read time; a stored score no read confirms now is
 * a muted "Previous: …".
 */
function QualityBadge({ row, tx }: { row: Template | null; tx: (en: string, ar: string) => string }) {
  const q = templateQualityCell(row ?? {}, tx);
  const lang = tx("en", "ar") as "en" | "ar";
  if (q.unknown) {
    return (
      <span
        className="badge"
        style={{ background: "transparent", border: "1px dashed var(--line)", color: "var(--ink-3)" }}
        title={q.previous ? tx("The last read didn't confirm this; it's the previously stored value", "لم تؤكّده آخر قراءة؛ هذه القيمة المخزّنة سابقًا") : undefined}
      >
        {q.label}
      </span>
    );
  }
  const title = [q.source, q.readAt ? `${tx("Read", "قُرئت")}: ${fmtWhen(q.readAt, lang, tx)}` : null].filter(Boolean).join("\n");
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }} title={title || undefined}>
      <Badge kind={q.tone === "good" ? "ok" : q.tone === "neutral" ? "" : q.tone} dot={q.tone !== "neutral"}>
        {q.label}
      </Badge>
      {q.source && <SourceMark label={tx("Via Zernio", "عبر Zernio")} />}
    </span>
  );
}

function RowMenuItem({
  label,
  onClick,
  destructive,
  disabled,
  title,
}: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
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
