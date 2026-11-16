import { useEffect, useRef, type ReactNode } from "react";
import { api } from "@/api/client";
import { Badge } from "@/components/Badge";
import { Skeleton } from "@/components/Skeleton";
import type {
  AwaySummary,
  HomeBookingRow,
  HomeDay,
  HomeDto,
  HomeFollowUpRow,
  HomeList,
  HomeSection,
  HomeTicketRow,
  WaitingConversationRow,
} from "@/lib/homeTypes";
import { recordHref } from "@/lib/recordLink";
import type { Tx } from "@/lib/tx";
import type { Lang } from "@/lib/types";
import { followUpHref, homeView, sectionView, waitingSinceWords } from "./homeModel";

/** How long the home must be on screen before it counts as "seen". */
export const HOME_SEEN_AFTER_MS = 3_000;

const LATIN = (lang: Lang) => (lang === "ar" ? "ar-SA-u-nu-latn" : "en-GB");
const time = (iso: string | null, tz: string, lang: Lang) =>
  iso ? new Intl.DateTimeFormat(LATIN(lang), { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "";
const dayTime = (iso: string | null, tz: string, lang: Lang) =>
  iso
    ? new Intl.DateTimeFormat(LATIN(lang), { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso))
    : "";
const here = () => (typeof window === "undefined" ? "#/dashboard" : window.location.hash || "#/dashboard");

function Unavailable({ tx }: { tx: Tx }) {
  return <div style={{ fontSize: 12, color: "var(--ink-3)", padding: "8px 0" }}>{tx("Not available right now", "غير متاح حاليًا")}</div>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--ink-3)", padding: "8px 0" }}>{children}</div>;
}

function RowLink({ href, title, meta, badge }: { href: string | null; title: ReactNode; meta?: ReactNode; badge?: ReactNode }) {
  const body = (
    <>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
      {badge}
      {meta !== undefined && <span style={{ fontSize: 12, color: "var(--ink-3)", flexShrink: 0 }}>{meta}</span>}
    </>
  );
  const style = { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderBlockEnd: "1px solid var(--line)", color: "inherit", textDecoration: "none" } as const;
  return href ? (
    <a href={href} style={style}>
      {body}
    </a>
  ) : (
    <div style={style}>{body}</div>
  );
}

function Panel({ title, total, more, children }: { title: string; total?: number; more?: { href: string; label: string }; children: ReactNode }) {
  return (
    <div className="card" style={{ padding: 16, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBlockEnd: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{title}</h3>
        {total !== undefined && (
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            <bdi>{total}</bdi>
          </span>
        )}
        {more && (
          <a href={more.href} style={{ marginInlineStart: "auto", fontSize: 12 }}>
            {more.label}
          </a>
        )}
      </div>
      {children}
    </div>
  );
}

function listBody<T>(s: HomeSection<HomeList<T>>, tx: Tx, empty: string, row: (r: T) => ReactNode) {
  if (s.status === "unavailable") return <Unavailable tx={tx} />;
  if (s.status !== "ok") return null;
  return s.data.items.length ? <>{s.data.items.map(row)}</> : <Empty>{empty}</Empty>;
}

interface Props {
  home: HomeDto | null;
  loading: boolean;
  tx: Tx;
  lang: Lang;
}

/** SP-11 working home: needs a person, today / tomorrow, while you were away. */
export function WorkingHome({ home, loading, tx, lang }: Props) {
  // Mark the home seen once it has been on screen for 3 s.
  const sent = useRef(false);
  useEffect(() => {
    if (!home || sent.current) return;
    const id = window.setTimeout(() => {
      if (document.visibilityState === "hidden") return;
      sent.current = true;
      void api.post("/home/seen").catch(() => undefined);
    }, HOME_SEEN_AFTER_MS);
    return () => window.clearTimeout(id);
  }, [home]);

  if (loading && !home) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} h={140} />
        ))}
      </div>
    );
  }
  if (!home) return null;
  const v = homeView(home);
  const now = new Date(home.now);
  const tz = home.tz;
  const n = home.needsPerson;

  const waitingRow = (r: WaitingConversationRow) => (
    <RowLink
      key={r.id}
      href={recordHref("conversation", r.id, here())}
      title={<bdi>{r.contactName || tx("Unknown contact", "جهة اتصال غير معروفة")}</bdi>}
      badge={r.escalated ? <Badge kind="bad">{tx("Escalated", "مصعّدة")}</Badge> : r.assigneeId === null ? <Badge>{tx("Unassigned", "غير مُسندة")}</Badge> : undefined}
      meta={<bdi>{waitingSinceWords(r.waitingSince, now, lang)}</bdi>}
    />
  );
  const followRow = (r: HomeFollowUpRow, withDay: boolean) => (
    <RowLink key={r.id} href={followUpHref(r, here())} title={<bdi>{r.title}</bdi>} meta={<bdi>{withDay ? dayTime(r.dueAt, tz, lang) : time(r.dueAt, tz, lang)}</bdi>} />
  );
  const ticketRow = (r: HomeTicketRow, sla: boolean) => (
    <RowLink
      key={r.id}
      href={recordHref("ticket", r.id, here())}
      title={
        <>
          <bdi>#{r.number}</bdi> <bdi>{r.title}</bdi>
        </>
      }
      badge={r.priority === "urgent" || r.priority === "high" ? <Badge kind={r.priority === "urgent" ? "bad" : "warn"}>{r.priority === "urgent" ? tx("Urgent", "عاجلة") : tx("High", "مرتفعة")}</Badge> : undefined}
      meta={<bdi>{sla ? time(r.slaDueAt, tz, lang) : r.slaDueAt ? dayTime(r.slaDueAt, tz, lang) : ""}</bdi>}
    />
  );
  const bookingRow = (r: HomeBookingRow) => (
    <RowLink
      key={r.id}
      href={recordHref("booking", r.id, here())}
      title={
        <>
          <bdi>{lang === "ar" ? r.serviceAr || r.service : r.service}</bdi>
          {r.contactName ? (
            <span style={{ color: "var(--ink-3)" }}>
              {" · "}
              <bdi>{r.contactName}</bdi>
            </span>
          ) : null}
        </>
      }
      badge={r.status === "pending" ? <Badge kind="warn">{tx("Pending", "قيد التأكيد")}</Badge> : undefined}
      meta={<bdi>{time(r.startAt, tz, lang)}</bdi>}
    />
  );

  const dayPanel = (label: string, d: HomeDay) => (
    <Panel title={label}>
      {v.days.map(({ key }) => {
        const s = d[key];
        const head = { followUps: tx("Follow-ups", "المتابعات"), bookings: tx("Bookings", "الحجوزات"), ticketsDue: tx("Tickets due", "تذاكر مستحقة") }[key];
        let body: ReactNode;
        if (s.status === "unavailable") body = <Unavailable tx={tx} />;
        else if (s.status !== "ok") body = null;
        else if (s.data.length === 0) body = <Empty>{tx("Nothing", "لا شيء")}</Empty>;
        else if (key === "followUps") body = (s.data as HomeFollowUpRow[]).map((r) => followRow(r, false));
        else if (key === "bookings") body = (s.data as HomeBookingRow[]).map(bookingRow);
        else body = (s.data as HomeTicketRow[]).map((r) => ticketRow(r, true));
        return (
          <div key={key} style={{ marginBlockEnd: 8 }}>
            <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", marginBlockStart: 6 }}>{head}</div>
            {body}
          </div>
        );
      })}
    </Panel>
  );

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {v.showNeedsPerson && (
        <section aria-label={tx("Needs a person", "تحتاج إلى شخص")}>
          <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>{tx("Needs a person", "تحتاج إلى شخص")}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
            {sectionView(n.waitingConversations) !== "hidden" && (
              <Panel
                title={tx("Waiting conversations", "محادثات بانتظار رد")}
                total={n.waitingConversations.status === "ok" ? n.waitingConversations.data.total : undefined}
                more={{ href: "#/inbox", label: tx("Open inbox", "فتح صندوق الوارد") }}
              >
                {listBody(n.waitingConversations, tx, tx("No one is waiting", "لا أحد بانتظار رد"), waitingRow)}
              </Panel>
            )}
            {sectionView(n.lateFollowUps) !== "hidden" && (
              <Panel
                title={tx("Late follow-ups", "متابعات متأخرة")}
                total={n.lateFollowUps.status === "ok" ? n.lateFollowUps.data.total : undefined}
                more={{ href: "#/followups", label: tx("All follow-ups", "كل المتابعات") }}
              >
                {listBody(n.lateFollowUps, tx, tx("Nothing late", "لا شيء متأخر"), (r: HomeFollowUpRow) => followRow(r, true))}
              </Panel>
            )}
            {sectionView(n.unassignedTickets) !== "hidden" && (
              <Panel
                title={tx("Unassigned tickets", "تذاكر غير مُسندة")}
                total={n.unassignedTickets.status === "ok" ? n.unassignedTickets.data.total : undefined}
                more={{ href: "#/pipeline", label: tx("Open pipeline", "فتح المسار") }}
              >
                {listBody(n.unassignedTickets, tx, tx("Every ticket has an owner", "كل التذاكر لها مسؤول"), (r: HomeTicketRow) => ticketRow(r, false))}
              </Panel>
            )}
          </div>
        </section>
      )}

      {v.showDays && (
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 12 }}>
          {dayPanel(tx("Today", "اليوم"), home.today)}
          {dayPanel(tx("Tomorrow", "غدًا"), home.tomorrow)}
        </section>
      )}

      {v.away !== "hidden" && <AwayPanel away={home.away} tx={tx} lang={lang} tz={tz} />}
    </div>
  );
}

function AwayPanel({ away, tx, lang, tz }: { away: HomeSection<AwaySummary>; tx: Tx; lang: Lang; tz: string }) {
  if (away.status === "unavailable") {
    return (
      <Panel title={tx("While you were away", "أثناء غيابك")}>
        <Unavailable tx={tx} />
      </Panel>
    );
  }
  if (away.status !== "ok") return null;
  const a = away.data;
  const facts: [number | null, string][] = [
    [a.aiReplies, tx("AI replies", "ردود الذكاء الاصطناعي")],
    [a.aiResolved, tx("Conversations the AI resolved", "محادثات حلّها الذكاء الاصطناعي")],
    [a.agentBookings, tx("Bookings made by customers", "حجوزات أجراها العملاء")],
    [a.autoTickets, tx("Tickets created automatically", "تذاكر أُنشئت تلقائيًا")],
  ];
  return (
    <Panel title={tx("While you were away", "أثناء غيابك")}>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBlockEnd: 8 }}>
        {tx("Since", "منذ")} <bdi>{dayTime(a.since, tz, lang)}</bdi>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginBlockEnd: 8 }}>
        {facts
          .filter(([v]) => v !== null)
          .map(([v, label]) => (
            <div key={label} className="stat" style={{ padding: 10 }}>
              <div className="label">{label}</div>
              <div className="value" style={{ fontSize: 20 }}>
                <bdi>{v}</bdi>
              </div>
            </div>
          ))}
      </div>
      {a.conversations.map((c) => (
        <RowLink
          key={c.id}
          href={recordHref("conversation", c.id, here())}
          title={<bdi>{c.contactName || tx("Unknown contact", "جهة اتصال غير معروفة")}</bdi>}
          meta={<bdi>{dayTime(c.resolvedAt, tz, lang)}</bdi>}
        />
      ))}
    </Panel>
  );
}
