import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "@/api/client";
import { openRecord } from "@/lib/openRecord";
import type { Tx } from "@/lib/tx";
import type { CampaignRecipientRow, Lang, RecipientsPage, RecipientStatus } from "@/lib/types";
import { Badge, type BadgeKind } from "@/components/Badge";
import { campaignErrorText } from "./campaignErrors";
import {
  mergePages,
  recipientsPath,
  selectionState,
  statusLabel,
  toggleAllLoaded,
  type Outcome,
  type OutcomeChip,
} from "./campaignDetailModel";
import { failureLabel } from "./failureCodes";
import { formatWhen, fmtNum } from "./ui";

interface Props {
  campaignId: string;
  outcome: Outcome;
  onOutcome: (o: Outcome) => void;
  chips: OutcomeChip[];
  selected: ReadonlySet<string>;
  onSelected: (next: Set<string>) => void;
  /** Bumped by Refresh: reloads the first page. Polling never touches the table. */
  reloadKey: number;
  tx: Tx;
  lang: Lang;
  tz: string | null;
}

const KIND: Record<RecipientStatus, BadgeKind> = {
  queued: "",
  sent: "info",
  delivered: "info",
  read: "ok",
  replied: "accent",
  failed: "bad",
  skipped: "warn",
};

const stickyCell = (head: boolean): CSSProperties => ({
  position: "sticky",
  insetInlineStart: 0,
  zIndex: head ? 2 : 1,
  background: "var(--bg-1)",
  minWidth: 200,
  maxWidth: 260,
});

/** Outcome chips, the recipients table with cursor "Load more", and row ticks. */
export function RecipientsTable({ campaignId, outcome, onOutcome, chips, selected, onSelected, reloadKey, tx, lang, tz }: Props) {
  const [rows, setRows] = useState<CampaignRecipientRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  async function load(from: string | null) {
    const req = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const page = await api.get<RecipientsPage>(recipientsPath(campaignId, outcome, from));
      if (req !== reqRef.current) return;
      setRows((prev) => (from ? mergePages(prev, page.items) : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      if (req !== reqRef.current) return;
      setError(campaignErrorText(e, tx));
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }

  // A new outcome or a Refresh starts from the first page (the cursor is only valid for one filter).
  useEffect(() => {
    setRows([]);
    setCursor(null);
    void load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, outcome, reloadKey]);

  const sel = selectionState(selected, rows);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelected(next);
  };
  const when = (iso: string | null) => formatWhen(iso, lang, tz, true);

  return (
    <section className="card" style={{ padding: 0, overflow: "hidden" }} aria-label={tx("Recipients", "المستلمون")}>
      <div className="card-h">
        <h3>{tx("Recipients", "المستلمون")}</h3>
      </div>
      <div role="group" aria-label={tx("Filter by outcome", "تصفية حسب النتيجة")} style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 18px 12px" }}>
        {chips.map((c) => {
          const on = c.id === outcome;
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={on}
              className="btn sm"
              onClick={() => onOutcome(c.id)}
              style={{
                borderRadius: 999,
                background: on ? "var(--accent-soft)" : undefined,
                borderColor: on ? "var(--accent-ring)" : undefined,
                color: on ? "var(--ink)" : "var(--ink-2)",
              }}
            >
              {c.label}
              <span className="mono" style={{ marginInlineStart: 6, fontSize: 11, color: "var(--ink-3)" }}>
                {fmtNum(c.count)}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="tbl" style={{ minWidth: 1180 }}>
          <thead>
            <tr>
              <th style={stickyCell(true)}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={sel === "all"}
                    ref={(el) => {
                      if (el) el.indeterminate = sel === "some";
                    }}
                    disabled={rows.length === 0}
                    onChange={() => onSelected(toggleAllLoaded(selected, rows))}
                    aria-label={tx("Tick all loaded rows", "تحديد كل الصفوف المحمّلة")}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  {tx("Name", "الاسم")}
                </label>
              </th>
              <th>{tx("Phone", "الهاتف")}</th>
              <th>{tx("Status", "الحالة")}</th>
              <th>{tx("Sent", "أُرسلت")}</th>
              <th>{tx("Delivered", "وصلت")}</th>
              <th>{tx("Read", "قُرئت")}</th>
              <th>{tx("Replied", "ردّ")}</th>
              <th>{tx("Reply / button", "الرد / الزر")}</th>
              <th>{tx("Failure", "سبب الفشل")}</th>
              <th>{tx("Sending number", "رقم الإرسال")}</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={10} style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>
                  {tx("Loading recipients…", "جارٍ تحميل المستلمين…")}
                </td>
              </tr>
            )}
            {!loading && !error && rows.length === 0 && (
              <tr>
                <td colSpan={10} style={{ padding: 24, color: "var(--ink-3)", fontSize: 13 }}>
                  {outcome === "all"
                    ? tx("No recipients yet.", "لا يوجد مستلمون بعد.")
                    : tx("No recipients with this outcome.", "لا يوجد مستلمون بهذه النتيجة.")}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const ticked = selected.has(r.id);
              const open = r.contactId ? () => openRecord("contact", r.contactId!) : undefined;
              return (
                <tr
                  key={r.id}
                  className={ticked ? "selected" : undefined}
                  onClick={open}
                  style={{ cursor: open ? "pointer" : "default" }}
                >
                  <td style={{ ...stickyCell(false), background: ticked ? "var(--accent-soft)" : "var(--bg-1)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="checkbox"
                        checked={ticked}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(r.id)}
                        aria-label={tx(`Tick ${r.name ?? r.phone ?? ""}`, `تحديد ${r.name ?? r.phone ?? ""}`)}
                        style={{ accentColor: "var(--accent)" }}
                      />
                      {open ? (
                        <button
                          type="button"
                          dir="auto"
                          onClick={(e) => {
                            e.stopPropagation();
                            open();
                          }}
                          style={{ background: "none", border: 0, padding: 0, color: "var(--ink)", fontWeight: 500, cursor: "pointer", textAlign: "start", font: "inherit" }}
                        >
                          {r.name || tx("Unnamed", "بلا اسم")}
                        </button>
                      ) : (
                        <span dir="auto" style={{ color: "var(--ink-2)" }} title={tx("Contact deleted", "جهة الاتصال محذوفة")}>
                          {r.name || tx("Unnamed", "بلا اسم")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="mono">{r.phone ? <bdi dir="ltr">{r.phone}</bdi> : "—"}</td>
                  <td>
                    <Badge kind={KIND[r.status]} dot>
                      {statusLabel(r.status, tx)}
                    </Badge>
                  </td>
                  <td className="muted mono">{when(r.sentAt)}</td>
                  <td className="muted mono">{when(r.deliveredAt)}</td>
                  <td className="muted mono">{when(r.readAt)}</td>
                  <td className="muted mono">{when(r.repliedAt)}</td>
                  <td style={{ maxWidth: 240 }}>
                    {r.buttonPayload && (
                      <span className="badge" style={{ marginInlineEnd: 6 }}>
                        <bdi dir="auto">{r.buttonPayload}</bdi>
                      </span>
                    )}
                    {r.replyText ? (
                      <span dir="auto" title={r.replyText} style={{ display: "inline-block", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "bottom" }}>
                        {r.replyText}
                      </span>
                    ) : (
                      !r.buttonPayload && <span className="muted">—</span>
                    )}
                  </td>
                  <td style={{ maxWidth: 240 }}>
                    {r.failureCode ? (
                      <span title={r.failureCode} style={{ fontSize: 12, color: r.status === "skipped" ? "var(--ink-2)" : "var(--bad)" }}>
                        {failureLabel(r.failureCode, r.failureTitle, tx)}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted">
                    {r.channel ? (
                      <>
                        <span dir="auto">{r.channel.displayName}</span>
                        {r.channel.phoneNumber && (
                          <span className="mono" style={{ marginInlineStart: 6, fontSize: 11 }}>
                            <bdi dir="ltr">{r.channel.phoneNumber}</bdi>
                          </span>
                        )}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error && (
        <div role="alert" style={{ padding: "10px 18px", fontSize: 12.5, color: "var(--bad)" }}>
          {error}{" "}
          <button className="btn ghost sm" onClick={() => void load(rows.length ? cursor : null)}>
            {tx("Try again", "حاول مجددًا")}
          </button>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 18px" }}>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
          {tx(`${fmtNum(rows.length)} loaded`, `تم تحميل ${fmtNum(rows.length)}`)}
        </span>
        <span style={{ flex: 1 }} />
        {cursor && (
          <button className="btn sm" disabled={loading} onClick={() => void load(cursor)}>
            {loading ? tx("Loading…", "جارٍ التحميل…") : tx("Load more", "تحميل المزيد")}
          </button>
        )}
      </div>
    </section>
  );
}
