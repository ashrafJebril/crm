import { memo, useMemo, useState } from "react";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/Badge";
import { Avatar } from "@/components/Avatar";
import { IconRadar, IconSend, IconStar } from "@/icons";
import { useFetch, useMutation } from "@/api/useFetch";
import { api } from "@/api/client";
import type { Mention, MentionStatus } from "@/lib/types";
import { DEMO_MENTIONS } from "@/data/mentions-extras";

type Filter = "all" | "new" | "negative" | "positive" | "triaged";

function sentimentColor(s: number | null): string {
  if (s === null) return "var(--ink-3)";
  if (s <= -0.3) return "var(--bad)";
  if (s >= 0.3) return "var(--ok)";
  return "var(--ink-2)";
}

function sentimentLabel(s: number | null): string {
  if (s === null) return "—";
  if (s <= -0.3) return "negative";
  if (s >= 0.3) return "positive";
  return "neutral";
}

const FILTER_LABELS: Record<Filter, [string, string]> = {
  all: ["all", "الكل"],
  new: ["new", "جديدة"],
  negative: ["negative", "سلبية"],
  positive: ["positive", "إيجابية"],
  triaged: ["triaged", "تمت المعالجة"],
};

function MentionsImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const isAr = t.lang === "ar";

  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const liveQ = useFetch<Mention[]>("/mentions");
  const data: Mention[] = useMemo(() => {
    if (liveQ.data && liveQ.data.length > 0) return liveQ.data;
    if (liveQ.loading) return [];
    return DEMO_MENTIONS;
  }, [liveQ.data, liveQ.loading]);

  const filtered = useMemo(() => {
    return data.filter((m) => {
      if (filter === "all") return true;
      if (filter === "new") return m.status === "new";
      if (filter === "triaged") return m.status === "triaged" || m.status === "engaged";
      if (filter === "negative") return (m.sentiment ?? 0) <= -0.3;
      if (filter === "positive") return (m.sentiment ?? 0) >= 0.3;
      return true;
    });
  }, [data, filter]);

  const selected = useMemo(
    () => filtered.find((m) => m.id === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  const openTicket = useMutation<{ id: string }, { ticketId: string; contactId: string }>((input) =>
    api.post(`/mentions/${input.id}/open-ticket`, {}),
  );

  const updateStatus = useMutation<{ id: string; status: MentionStatus }, Mention>((input) =>
    api.patch(`/mentions/${input.id}`, { status: input.status }),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <PageHeader
        title={tx("Mentions", "الإشارات")}
        subtitle={tx(
          "Brand mentions across web and Instagram — with sentiment and dialect",
          "إشارات العلامة عبر الويب وإنستغرام — مع المشاعر واللهجة",
        )}
        actions={
          <button className="btn">
            <IconStar w={13} />
            {tx("Saved", "المحفوظات")}
          </button>
        }
      />

      <div className="tabs" style={{ padding: "0 24px" }}>
        {(["all", "new", "negative", "positive", "triaged"] as Filter[]).map((f) => {
          const [en, ar] = FILTER_LABELS[f];
          return (
            <button
              key={f}
              type="button"
              className={`tab ${filter === f ? "active" : ""}`.trim()}
              onClick={() => setFilter(f)}
            >
              <span>{tx(en, ar)}</span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", flex: 1, minHeight: 0 }}>
        {/* List panel */}
        <div style={{ borderInlineEnd: "1px solid var(--line-soft)", overflowY: "auto" }}>
          {filtered.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setSelectedId(m.id)}
              style={{
                display: "flex",
                gap: 10,
                padding: 12,
                width: "100%",
                textAlign: "start",
                background: m.id === selected?.id ? "var(--accent-soft)" : "transparent",
                border: 0,
                borderBottom: "1px solid var(--line-soft)",
                cursor: "pointer",
                color: "inherit",
                font: "inherit",
              }}
            >
              <Avatar name={m.author} color="200" size="sm" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{m.author}</span>
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {m.source}
                  </span>
                  {m.dialect && <Badge kind="ai">{m.dialect}</Badge>}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--ink-2)",
                    lineHeight: 1.4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                  }}
                >
                  {m.body}
                </div>
                <div className="mono" style={{ fontSize: 11, color: sentimentColor(m.sentiment), marginTop: 2 }}>
                  {sentimentLabel(m.sentiment)}
                  {m.topic ? ` · ${m.topic}` : ""}
                </div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="mono muted" style={{ padding: 16, fontSize: 12 }}>
              {tx("No mentions match this filter.", "لا توجد إشارات تطابق هذا الفلتر.")}
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div style={{ display: "flex", flexDirection: "column", overflowY: "auto" }}>
          {selected ? (
            <>
              <div style={{ padding: 18, borderBottom: "1px solid var(--line-soft)" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <Avatar name={selected.author} color="200" size="lg" />
                  <div>
                    <div style={{ fontWeight: 600 }}>{selected.author}</div>
                    <div className="mono muted" style={{ fontSize: 11 }}>
                      {selected.source} · {selected.lang ?? "?"}{" "}
                      {selected.dialect ? `(${selected.dialect})` : ""}
                    </div>
                  </div>
                  <span style={{ marginInlineStart: "auto" }}>
                    <Badge kind="ai">{sentimentLabel(selected.sentiment)}</Badge>
                  </span>
                </div>
                <p style={{ marginTop: 12, fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                  {isAr && selected.lang === "ar" ? selected.body : selected.body}
                </p>
                {selected.sourceUrl && (
                  <a
                    className="mono"
                    style={{ fontSize: 12 }}
                    href={selected.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {tx("Open source", "افتح المصدر")} ↗
                  </a>
                )}
              </div>

              <div style={{ padding: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={openTicket.loading}
                  onClick={() => {
                    void openTicket.mutate({ id: selected.id }).then(() => liveQ.refetch());
                  }}
                >
                  <IconSend w={13} />
                  {tx("Open ticket", "افتح بطاقة")}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={updateStatus.loading}
                  onClick={() => {
                    void updateStatus
                      .mutate({ id: selected.id, status: "dismissed" })
                      .then(() => liveQ.refetch());
                  }}
                >
                  {tx("Dismiss", "تجاهل")}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={updateStatus.loading}
                  onClick={() => {
                    void updateStatus
                      .mutate({ id: selected.id, status: "engaged" })
                      .then(() => liveQ.refetch());
                  }}
                >
                  {tx("Mark engaged", "تم التواصل")}
                </button>
                {openTicket.error && (
                  <span style={{ color: "var(--bad)", fontSize: 12 }}>{openTicket.error}</span>
                )}
              </div>
            </>
          ) : (
            <div className="mono muted" style={{ padding: 24, fontSize: 13 }}>
              <IconRadar w={14} /> {tx("Select a mention", "اختر إشارة")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const Mentions = memo(MentionsImpl);
export default Mentions;
