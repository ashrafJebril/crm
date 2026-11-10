import { useEffect, useState } from "react";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { NO_PERMISSION_AR, NO_PERMISSION_EN, usePermissions } from "@/auth/usePermissions";
import { useToast } from "@/components/Toast";
import type { Tx } from "@/lib/tx";
import type { ChannelDto, ChannelTemplatesResponse, Lang } from "@/lib/types";
import { channelErrorText } from "../channelErrors";
import { ErrorText } from "../channelUi";
import {
  FIELD_LABEL,
  FIELD_ORDER,
  TIER_SHARED_NOTE,
  checkButtonLabel,
  cooldownLeft,
  issueText,
  issueTone,
  laterOf,
  nextCheckFromError,
  overallView,
  signalView,
  templateQualityView,
  templateStatusView,
  templatesView,
  unknownReason,
} from "./healthModel";
import { SignalValue, SourceMark, ToneChip, fmtWhen } from "./healthUi";

/**
 * SP-14: a WhatsApp number's health inside the channel detail: the overall
 * chip, every field (with its check time and why it is unknown), the issues,
 * "Check now" (channels.update) with a live cooldown, and the templates on
 * this number (templates.view).
 */
export function NumberHealthSection({
  channel,
  tx,
  lang,
  canUpdate,
  onUpdated,
}: {
  channel: ChannelDto;
  tx: Tx;
  lang: Lang;
  canUpdate: boolean;
  onUpdated: (c: ChannelDto) => void;
}) {
  const { can } = usePermissions();
  const canViewTemplates = can("templates.view");
  const { toast } = useToast();
  const h = channel.health ?? null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The cooldown from a 429 (nextAt / retryAfter) until the DTO catches up.
  const [localNext, setLocalNext] = useState<string | null>(null);
  const nextAt = laterOf(channel.healthNextCheckAt ?? null, localNext);
  const [now, setNow] = useState(() => Date.now());
  const left = cooldownLeft(nextAt, now);
  const counting = left > 0;

  useEffect(() => {
    setNow(Date.now());
  }, [nextAt]);
  useEffect(() => {
    if (!counting) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [counting]);
  // A cooldown message goes stale once the countdown ends.
  useEffect(() => {
    if (!counting) setError((e) => (e && localNext ? null : e));
  }, [counting]); // eslint-disable-line react-hooks/exhaustive-deps

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await api.post<ChannelDto>(`/channels/${encodeURIComponent(channel.id)}/health/check`);
      setLocalNext(c?.healthNextCheckAt ?? null);
      if (c && c.id === channel.id) onUpdated(c);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        toast(tx(NO_PERMISSION_EN, NO_PERMISSION_AR), "error");
      } else {
        if (e instanceof ApiError && e.status === 429) setLocalNext(nextCheckFromError(e.body, Date.now()));
        setError(channelErrorText(e, tx));
      }
    } finally {
      setBusy(false);
    }
  };

  const overall = overallView(h, tx);
  const tpl = templatesView(h?.templates, tx);
  const issues = h?.issues ?? [];

  return (
    <section
      aria-label={tx("Number health", "صحة الرقم")}
      style={{ display: "grid", gap: 12, paddingBlockStart: 12, borderBlockStart: "1px solid var(--line-soft)" }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{tx("Number health", "صحة الرقم")}</span>
        <ToneChip tone={overall.tone} unknown={!h || h.overall === "unknown"}>
          {overall.label}
        </ToneChip>
        <span className="muted" style={{ fontSize: 11.5, flex: 1, minWidth: 140 }}>
          {tx("Last checked", "آخر فحص")}: {fmtWhen(channel.healthCheckedAt ?? h?.checkedAt ?? null, lang, tx)}
        </span>
        {canUpdate && (
          <button
            type="button"
            className="btn sm"
            onClick={check}
            disabled={busy || counting}
            aria-live="polite"
            title={counting ? tx("A number can be checked once a minute.", "يمكن فحص الرقم مرة كل دقيقة.") : undefined}
          >
            {checkButtonLabel(left, busy, tx)}
          </button>
        )}
      </div>

      <ErrorText>{error}</ErrorText>

      {!h && (
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
          {tx(
            "This number hasn't been checked yet. Numbers are checked about once a day.",
            "لم يُفحص هذا الرقم بعد. تُفحص الأرقام مرة يوميًا تقريبًا.",
          )}
        </div>
      )}

      {h && issues.length > 0 && (
        <ul style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 3, fontSize: 12.5, lineHeight: 1.45 }}>
          {issues.map((k) => {
            const tone = issueTone(k);
            return (
              <li key={k} style={{ color: tone === "bad" ? "var(--bad)" : tone === "warn" ? "var(--warn)" : "var(--ink-2)" }}>
                {issueText(k, tx)}
              </li>
            );
          })}
        </ul>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
        {FIELD_ORDER.map((f) => {
          const sig = h?.[f];
          const view = signalView(f, sig, tx, h?.lastKnown?.[f]);
          return (
            <div key={f} style={{ display: "grid", gap: 4, padding: 10, borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line-soft)" }}>
              <span style={{ fontSize: 11, color: "var(--ink-3)" }} title={f === "tier" ? tx(TIER_SHARED_NOTE.en, TIER_SHARED_NOTE.ar) : undefined}>
                {tx(FIELD_LABEL[f].en, FIELD_LABEL[f].ar)}
              </span>
              <SignalValue view={view} tx={tx} lang={lang} />
              {sig?.checkedAt && (
                <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
                  {tx("Checked", "فُحص")}: {fmtWhen(sig.checkedAt, lang, tx)}
                </span>
              )}
            </div>
          );
        })}
        <div style={{ display: "grid", gap: 4, padding: 10, borderRadius: 8, background: "var(--bg-2)", border: "1px solid var(--line-soft)" }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{tx(FIELD_LABEL.templates.en, FIELD_LABEL.templates.ar)}</span>
          <SignalValue view={tpl} tx={tx} lang={lang} />
          {h?.templates?.checkedAt && (
            <span style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
              {tx("Checked", "فُحص")}: {fmtWhen(h.templates.checkedAt, lang, tx)}
            </span>
          )}
        </div>
      </div>
      <div className="muted" style={{ fontSize: 11, lineHeight: 1.45 }}>
        {tx(TIER_SHARED_NOTE.en, TIER_SHARED_NOTE.ar)}
      </div>

      {canViewTemplates && <NumberTemplates channelId={channel.id} refreshKey={channel.healthCheckedAt ?? ""} tx={tx} lang={lang} />}
    </section>
  );
}

/** "Templates on this number" (GET /channels/:id/templates; snapshot only, no provider call). */
function NumberTemplates({ channelId, refreshKey, tx, lang }: { channelId: string; refreshKey: string; tx: Tx; lang: Lang }) {
  const q = useFetch<ChannelTemplatesResponse>(`/channels/${encodeURIComponent(channelId)}/templates`, { key: refreshKey });
  const d = q.data;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{tx("Templates on this number", "القوالب على هذا الرقم")}</span>
        {d?.checkedAt && (
          <span className="muted" style={{ fontSize: 11 }}>
            {tx("Read", "قُرئت")}: {fmtWhen(d.checkedAt, lang, tx)}
          </span>
        )}
      </div>
      {q.loading && !d && <div className="muted pulse" style={{ fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</div>}
      {q.error && !d && <ErrorText>{channelErrorText(new Error(q.error), tx)}</ErrorText>}
      {d && !d.known && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
          <ToneChip tone="neutral" unknown>
            {tx("Unknown", "غير معروف")}
          </ToneChip>
          <span className="muted">
            {d.error
              ? unknownReason(d.error, tx)
              : tx("This number's template list hasn't been read yet.", "لم تُقرأ قائمة قوالب هذا الرقم بعد.")}
          </span>
        </div>
      )}
      {d && d.known && d.items.length === 0 && (
        <div className="muted" style={{ fontSize: 12 }}>{tx("No templates on this number.", "لا توجد قوالب على هذا الرقم.")}</div>
      )}
      {d && d.known && d.items.length > 0 && (
        <div style={{ overflowX: "auto", maxHeight: 280, overflowY: "auto" }}>
          <table className="tbl" style={{ fontSize: 12 }}>
            <thead>
              <tr>
                <th>{tx("Name", "الاسم")}</th>
                <th>{tx("Language", "اللغة")}</th>
                <th>{tx("Status", "الحالة")}</th>
                <th>{tx("Quality", "الجودة")}</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((t, i) => {
                const st = templateStatusView(t.status, tx);
                const ql = templateQualityView(t.quality, tx);
                return (
                  <tr key={`${t.id ?? t.name}-${t.language}-${i}`}>
                    <td className="mono">
                      <bdi dir="ltr">{t.name}</bdi>
                    </td>
                    <td className="mono">
                      <bdi dir="ltr">{t.language}</bdi>
                    </td>
                    <td>
                      <ToneChip tone={st.tone} unknown={st.unknown}>
                        {st.label}
                      </ToneChip>
                    </td>
                    <td>
                      <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                        <ToneChip tone={ql.tone} unknown={ql.unknown} title={ql.unknown ? tx("This provider didn't report it", "لم يُبلغ المزوّد عنها") : undefined}>
                          {ql.label}
                        </ToneChip>
                        {t.source === "zernio_passthrough" && <SourceMark label={tx("Via Zernio", "عبر Zernio")} />}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {d?.truncated && (
        <div className="muted" style={{ fontSize: 11 }}>
          {tx("Only the first 500 templates are listed.", "تُعرض أول 500 قالب فقط.")}
        </div>
      )}
    </div>
  );
}
