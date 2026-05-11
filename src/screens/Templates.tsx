import { memo, useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/Avatar";
import { Badge, type BadgeKind } from "@/components/Badge";
import { PhotoSlot } from "@/components/PhotoSlot";
import {
  IconBolt,
  IconFilter,
  IconMore,
  IconPlus,
  IconSearch,
  IconSparkles,
} from "@/icons";
import {
  MEDIA_ASSETS,
  QUICK_REPLIES,
  TPL_LIBRARY,
  type TemplateCategory,
  type TemplateFull,
  type TemplateStatus,
} from "@/data/templates-extras";
import { useFetch } from "@/api/useFetch";
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
  MARKETING: "ai",
  AUTHENTICATION: "warn",
};

const STATUS_BADGE: Record<TemplateStatus, BadgeKind> = {
  approved: "ok",
  pending: "warn",
  rejected: "bad",
};

interface TemplatePreviewProps {
  selected: TemplateFull;
  isAr: boolean;
}

function TemplatePreview({ selected, isAr }: TemplatePreviewProps) {
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
        <Badge kind={STATUS_BADGE[selected.status]} dot>
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
        <button className="btn sm" style={{ flex: 1 }}>
          <IconBolt w={12} />
          {isAr ? "اختبار" : "Test send"}
        </button>
        <button className="btn sm" style={{ flex: 1 }}>
          {isAr ? "نسخ" : "Duplicate"}
        </button>
        <button className="btn sm primary" style={{ flex: 1 }}>
          {isAr ? "تعديل" : "Edit"}
        </button>
      </div>
    </div>
  );
}

// Merge an API Template with the richer TPL_LIBRARY entry (matched by name) so
// the preview pane still has body/buttons/updated. If no library match exists
// we fall back to sensible defaults.
function toTemplateFull(t: Template): TemplateFull {
  const match = TPL_LIBRARY.find((x) => x.name === t.name);
  const category: TemplateCategory =
    t.category === "TRANSACTIONAL" ||
    t.category === "UTILITY" ||
    t.category === "MARKETING" ||
    t.category === "AUTHENTICATION"
      ? t.category
      : "UTILITY";
  return {
    id: t.id,
    name: t.name,
    lang: t.lang,
    category,
    status: t.status,
    uses: t.uses,
    updated: match?.updated ?? "—",
    body: match?.body ?? "",
    buttons: match?.buttons ?? [],
  };
}

function TemplatesImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const isAr = t.lang === "ar";

  const [tab, setTab] = useState<Tab>("library");
  const [filter, setFilter] = useState<CategoryFilter>("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState<string>("");

  const {
    data: templates,
    loading,
    error,
    refetch,
  } = useFetch<Template[]>("/templates");

  // Use the API list as the source of truth; pipe each row through
  // toTemplateFull to upgrade to the richer shape used by the rest of the UI.
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
            <button className="btn">
              <IconSparkles w={14} />
              {tx("Draft with AI", "اقترح بالذكاء")}
            </button>
            <button className="btn primary">
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
                    {list.map((tpl) => (
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
                          <Badge kind={STATUS_BADGE[tpl.status]} dot>
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
                        <td>
                          <IconMore w={14} />
                        </td>
                      </tr>
                    ))}
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

          {selected ? (
            <TemplatePreview selected={selected} isAr={isAr} />
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
    </div>
  );
}

const Templates = memo(TemplatesImpl);
export default Templates;
