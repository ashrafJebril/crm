import { useEffect, useState } from "react";
import { useFetch } from "@/api/useFetch";
import { Badge } from "@/components/Badge";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/Toast";
import { ErrorRow, inputStyle } from "@/screens/settings/form";
import type { Tx } from "@/lib/tx";
import type { KnowledgeSource, PageState, WebsiteSchedule } from "@/lib/types";
import { checkWebsite, createWebsite, deleteSource, patchWebsite, refreshWebsite, sourcesPath, type SourceList, type WebsiteCheck } from "./knowledgeApi";
import { KNOWLEDGE_POLL_MS, PAGE_STATES, SCHEDULES, WEBSITE_MAX_SOURCES } from "./knowledgeConstants";
import { cooldownSeconds, knowledgeErrorText, knowledgeKeyText } from "./knowledgeErrors";
import { BADGE_KIND, badgeText, formatWhen, pageStateText, retryNote, shouldPoll, sourceBadge } from "./knowledgeStatus";
import { countdownText } from "./countdown";
import { WebsitePages } from "./WebsitePages";

export function scheduleText(s: WebsiteSchedule, tx: Tx): string {
  return s === "daily" ? tx("Daily", "يوميًا") : s === "weekly" ? tx("Weekly", "أسبوعيًا") : s === "monthly" ? tx("Monthly", "شهريًا") : tx("Manual", "يدويًا");
}

function AddWebsiteDialog({ tx, lang, onClose, onAdded }: { tx: Tx; lang: "en" | "ar"; onClose: () => void; onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [check, setCheck] = useState<WebsiteCheck | null>(null);
  const [scope, setScope] = useState<"site" | "path">("site");
  const [schedule, setSchedule] = useState<WebsiteSchedule>("weekly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doCheck() {
    setBusy(true);
    setError(null);
    setCheck(null);
    try {
      setCheck(await checkWebsite(url));
    } catch (e) {
      setError(knowledgeErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    if (!check) return;
    setBusy(true);
    setError(null);
    try {
      await createWebsite({ url: check.normalizedUrl, scope, schedule });
      onAdded();
      onClose();
    } catch (e) {
      setError(knowledgeErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} width={560} label={tx("Add a website", "إضافة موقع")}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Add a website", "إضافة موقع")}</div>
        <div className="muted" style={{ fontSize: 12 }}>
          {tx(
            "Your assistant reads your public website and keeps it up to date. It follows robots.txt and never leaves your site.",
            "يقرأ مساعدك موقعك العام ويحدّثه باستمرار. يلتزم بملف robots.txt ولا يغادر موقعك أبدًا.",
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            dir="ltr"
            style={inputStyle}
            value={url}
            placeholder="https://example.com"
            aria-label={tx("Website address", "عنوان الموقع")}
            onChange={(e) => {
              setUrl(e.target.value);
              setCheck(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && url.trim()) void doCheck();
            }}
          />
          <button type="button" className="btn" onClick={() => void doCheck()} disabled={busy || !url.trim()}>
            {tx("Check", "تحقق")}
          </button>
        </div>
        {check && (
          <div style={{ border: "1px solid var(--line-soft)", borderRadius: 10, padding: 12, display: "grid", gap: 6, fontSize: 13 }}>
            <div>
              <bdi dir="ltr" className="mono">{check.normalizedUrl}</bdi>
            </div>
            {!check.robotsAllowed && (
              <div style={{ color: "var(--warn)" }}>
                {tx("This site's robots.txt does not allow reading this address; those pages will be skipped.", "لا يسمح ملف robots.txt لهذا الموقع بقراءة هذا العنوان، لذلك سيتم تخطي هذه الصفحات.")}
              </div>
            )}
            <div className="muted" style={{ fontSize: 12 }}>
              {check.sitemapPages === null
                ? tx("No sitemap found: pages will be found through links.", "لم يُعثر على خريطة موقع: سيتم العثور على الصفحات عبر الروابط.")
                : tx(`The sitemap lists ${check.sitemapPages} pages.`, `تسرد خريطة الموقع ${check.sitemapPages} صفحة.`)}
            </div>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span>{tx("What to read", "ما الذي يُقرأ")}</span>
              <select style={inputStyle} value={scope} onChange={(e) => setScope(e.target.value as "site" | "path")}>
                <option value="site">{tx("The whole site", "الموقع كله")}</option>
                <option value="path">{tx("Only pages under this address", "الصفحات تحت هذا العنوان فقط")}</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              <span>{tx("Update", "التحديث")}</span>
              <select style={inputStyle} value={schedule} onChange={(e) => setSchedule(e.target.value as WebsiteSchedule)}>
                {SCHEDULES.map((s) => (
                  <option key={s} value={s}>
                    {scheduleText(s, tx)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        <ErrorRow message={error} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="button" className="btn primary" onClick={() => void add()} disabled={busy || !check}>
            {tx("Add website", "إضافة الموقع")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * SP-21 websites: add (check, scope, schedule), and per site its state,
 * last sync, page counts by state, Refresh with the cooldown countdown,
 * Pause/Resume, schedule change, pages and delete.
 */
export function WebsitesPanel({
  tx,
  lang,
  timeZone,
  canCreate,
  canEdit,
  canDelete,
}: {
  tx: Tx;
  lang: "en" | "ar";
  timeZone?: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const { toast } = useToast();
  const q = useFetch<SourceList>(sourcesPath("website"), { pollMs: (d) => (shouldPoll(d?.items ?? []) ? KNOWLEDGE_POLL_MS : null) });
  const sites = q.data?.items ?? [];
  const [adding, setAdding] = useState(false);
  const [pages, setPages] = useState<KnowledgeSource | null>(null);
  /** Refresh cooldowns by source id: the time (ms) the button comes back. */
  const [cooldown, setCooldown] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!Object.values(cooldown).some((t) => t > now)) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [cooldown, now]);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await q.refetch();
    } catch (e) {
      toast(knowledgeErrorText(e, tx), "error", e);
    }
  }

  async function refresh(s: KnowledgeSource) {
    try {
      await refreshWebsite(s.id);
      await q.refetch();
    } catch (e) {
      const left = cooldownSeconds(e);
      if (left !== null) setCooldown((c) => ({ ...c, [s.id]: Date.now() + left * 1000 }));
      toast(knowledgeErrorText(e, tx), "error", e);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="muted" style={{ fontSize: 13, maxWidth: 820 }}>
        {tx(`Up to ${WEBSITE_MAX_SOURCES} websites. Pages your assistant can't read are listed so you can fix them.`, `حتى ${WEBSITE_MAX_SOURCES} مواقع. تُعرض الصفحات التي لا يستطيع مساعدك قراءتها لتتمكن من إصلاحها.`)}
      </div>
      {canCreate && (
        <div>
          <button type="button" className="btn primary" onClick={() => setAdding(true)} disabled={sites.length >= WEBSITE_MAX_SOURCES}>
            {tx("Add website", "إضافة موقع")}
          </button>
        </div>
      )}
      <ErrorRow message={q.error ? knowledgeErrorText(null, tx, q.error) : null} />
      {sites.length === 0 && !q.loading && (
        <div className="muted" style={{ fontSize: 13, padding: "24px 0", textAlign: "center" }}>
          {tx("No websites yet.", "لا توجد مواقع بعد.")}
        </div>
      )}
      <div style={{ display: "grid", gap: 10 }}>
        {sites.map((s) => {
          const badge = sourceBadge(s);
          const note = retryNote(s, tx);
          const err = s.error ? knowledgeKeyText(s.error, tx) : null;
          const left = Math.max(0, Math.ceil(((cooldown[s.id] ?? 0) - now) / 1000));
          const counts = PAGE_STATES.filter((st) => (s.pageCounts?.[st] ?? 0) > 0);
          return (
            <div key={s.id} style={{ border: "1px solid var(--line-soft)", borderRadius: 12, padding: 14, background: "var(--bg-1)", display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <div style={{ fontWeight: 600 }}>
                    <bdi dir="ltr">{s.title}</bdi>
                  </div>
                  <div className="mono muted" style={{ fontSize: 11, overflowWrap: "anywhere" }}>
                    <bdi dir="ltr">{s.url}</bdi>
                    {s.scope === "path" && <span style={{ marginInlineStart: 6 }}>{tx("(this path only)", "(هذا المسار فقط)")}</span>}
                  </div>
                </div>
                <Badge kind={BADGE_KIND[badge]} dot>
                  {badgeText(badge, tx)}
                </Badge>
              </div>
              {(err || note) && (
                <div style={{ fontSize: 12, color: s.status === "failed" ? "var(--bad)" : "var(--ink-2)" }}>
                  {[err, note].filter(Boolean).join(" · ")}
                </div>
              )}
              <div className="muted" style={{ fontSize: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
                <span>
                  {tx("Last sync", "آخر مزامنة")}: <bdi>{formatWhen(s.lastSyncAt, lang, timeZone)}</bdi>
                </span>
                {s.schedule !== "manual" && s.status !== "paused" && s.status !== "failed" && (
                  <span>
                    {tx("Next", "التالية")}: <bdi>{formatWhen(s.nextSyncAt, lang, timeZone)}</bdi>
                  </span>
                )}
                <span>
                  {tx("Passages", "المقاطع")}: <bdi>{s.itemCount}</bdi>
                </span>
              </div>
              {counts.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {counts.map((st: PageState) => (
                    <span key={st} className="chip" style={{ fontSize: 11, border: "1px solid var(--line-soft)", borderRadius: 999, padding: "2px 8px" }}>
                      {pageStateText(st, tx)} <bdi className="mono">{s.pageCounts?.[st]}</bdi>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <button type="button" className="btn ghost sm" onClick={() => setPages(s)}>
                  {tx("Pages", "الصفحات")}
                </button>
                {canEdit && s.status !== "paused" && (
                  <button type="button" className="btn ghost sm" onClick={() => void refresh(s)} disabled={left > 0}>
                    {left > 0 ? tx(`Refresh in ${countdownText(left)}`, `التحديث بعد ${countdownText(left)}`) : tx("Refresh now", "تحديث الآن")}
                  </button>
                )}
                {canEdit && (
                  <button type="button" className="btn ghost sm" onClick={() => void act(() => patchWebsite(s.id, { paused: s.status !== "paused", version: s.version }))}>
                    {s.status === "paused" ? tx("Resume", "استئناف") : tx("Pause", "إيقاف مؤقت")}
                  </button>
                )}
                {canEdit && s.schedule && (
                  <select
                    style={{ ...inputStyle, height: 30, width: 130 }}
                    value={s.schedule}
                    aria-label={tx("Update schedule", "جدول التحديث")}
                    onChange={(e) => void act(() => patchWebsite(s.id, { schedule: e.target.value as WebsiteSchedule, version: s.version }))}
                  >
                    {SCHEDULES.map((v) => (
                      <option key={v} value={v}>
                        {scheduleText(v, tx)}
                      </option>
                    ))}
                  </select>
                )}
                <span style={{ flex: 1 }} />
                {canDelete && (
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => {
                      if (window.confirm(tx(`Remove ${s.title} and everything read from it?`, `إزالة ${s.title} وكل ما قُرئ منه؟`))) void act(() => deleteSource(s.id));
                    }}
                  >
                    {tx("Delete", "حذف")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {adding && <AddWebsiteDialog tx={tx} lang={lang} onClose={() => setAdding(false)} onAdded={() => void q.refetch()} />}
      {pages && <WebsitePages tx={tx} lang={lang} timeZone={timeZone} sourceId={pages.id} title={pages.url ?? pages.title} onClose={() => setPages(null)} />}
    </div>
  );
}
