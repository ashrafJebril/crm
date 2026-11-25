import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { Badge, type BadgeKind } from "@/components/Badge";
import { Modal } from "@/components/Modal";
import { Skeleton } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import type { Tx } from "@/lib/tx";
import type { Lang, MetaAdsCandidates, MetaAdsConnectionDto } from "@/lib/types";
import { Banner, ConfirmDialog, ErrorText } from "../channels/channelUi";
import {
  adsErrorText,
  CONFIG_MISSING_COPY,
  errorExtras,
  oauthReturnText,
  statusReasonText,
  syncErrorText,
} from "./adsErrors";
import { clearOauthReturn, connectionView, cooldownSeconds, oauthReturn, type Tone } from "./adsModel";

export const CONNECTION_PATH = "/meta-ads/connection";

const BADGE: Record<Tone, BadgeKind> = { ok: "ok", warn: "warn", bad: "bad", info: "info", muted: "" };

const fmtWhen = (iso: string | null | undefined, lang: Lang) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? null
    : new Date(t).toLocaleString(lang === "ar" ? "ar-u-nu-latn" : "en-US", { dateStyle: "medium", timeStyle: "short" });
};

/** The missing server settings, as a checklist (managers only; never a secret value, only env names). */
function SetupChecklist({ missing, tx }: { missing: string[]; tx: Tx }) {
  return (
    <Banner tone="info" title={tx("Finish the Meta Ads setup on the server", "أكمل إعداد إعلانات Meta على الخادم")}>
      <ul style={{ margin: "4px 0 0", paddingInlineStart: 18 }}>
        {missing.map((m) => {
          const c = CONFIG_MISSING_COPY[m];
          return (
            <li key={m}>
              {c ? tx(c.en, c.ar) : m} <code className="mono" dir="ltr">{m}</code>
            </li>
          );
        })}
      </ul>
    </Banner>
  );
}

/** Starts the Meta login: the backend returns Meta's URL, and the browser goes there. */
export function useStartOAuth(tx: Tx) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; missing: string[] } | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<{ url: string }>("/meta-ads/oauth/start");
      if (!r?.url || !/^https:\/\//i.test(r.url)) throw new Error("meta_ads.not_configured");
      window.location.assign(r.url);
    } catch (e) {
      const m = errorExtras(e).missing;
      setError({ text: adsErrorText(e, tx), missing: Array.isArray(m) ? m.filter((x): x is string => typeof x === "string") : [] });
      setBusy(false);
    }
  };
  return { start, busy, error };
}

export function MetaAdsConnect({ tx, lang, canManage }: { tx: Tx; lang: Lang; canManage: boolean }) {
  const { toast } = useToast();
  const connQ = useFetch<MetaAdsConnectionDto>(CONNECTION_PATH);
  const conn = connQ.data;
  const view = connectionView(conn, tx);
  const oauth = useStartOAuth(tx);
  const [returnError, setReturnError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [busy, setBusy] = useState<"check" | "disconnect" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The OAuth callback lands on `#/ads?tab=connection&metaAds=choose|error&code=…`: read it once, then drop it.
  useEffect(() => {
    const r = oauthReturn(window.location.hash);
    if (!r) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search + clearOauthReturn(window.location.hash));
    if (r.kind === "choose") setPicking(true);
    else setReturnError(oauthReturnText(r.code, tx));
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    if (cooldownUntil === null) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= cooldownUntil) setCooldownUntil(null);
    }, 1000);
    return () => window.clearInterval(id);
  }, [cooldownUntil]);
  const cooldownLeft = cooldownUntil !== null ? Math.max(0, Math.ceil((cooldownUntil - now) / 1000)) : 0;

  const setConn = (dto: MetaAdsConnectionDto) => connQ.setData(dto);

  const check = async () => {
    setBusy("check");
    setActionError(null);
    try {
      const dto = await api.post<MetaAdsConnectionDto>("/meta-ads/check");
      setConn(dto);
      if (dto.status === "active") toast(tx("Meta Ads connection works.", "ربط إعلانات Meta يعمل."), "success");
      else toast(statusReasonText(dto.statusReason, tx) ?? tx("Meta Ads needs reconnecting.", "إعلانات Meta تحتاج إلى إعادة ربط."), "error");
    } catch (e) {
      const secs = cooldownSeconds(errorExtras(e));
      if (secs) {
        setNow(Date.now());
        setCooldownUntil(Date.now() + secs * 1000);
      }
      setActionError(adsErrorText(e, tx));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy("disconnect");
    setActionError(null);
    try {
      setConn(await api.delete<MetaAdsConnectionDto>(CONNECTION_PATH));
      setConfirmDisconnect(false);
      toast(tx("Meta Ads disconnected.", "تم فصل إعلانات Meta."), "success");
    } catch (e) {
      setActionError(adsErrorText(e, tx));
    } finally {
      setBusy(null);
    }
  };

  if (connQ.loading && !conn) return <Skeleton h={160} radius={12} />;
  if (connQ.error && !conn) return <Banner tone="bad">{adsErrorText(connQ.error, tx)}</Banner>;
  if (!conn) return null;

  const connected = conn.status === "active" || conn.status === "needs_reconnect";
  const missing = canManage ? (conn.config.missing ?? []) : [];
  const reason = statusReasonText(conn.statusReason, tx);
  const syncError = syncErrorText(conn.lastSyncError, tx);
  const row = (label: string, value: React.ReactNode) =>
    value ? (
      <div style={{ display: "contents" }}>
        <dt style={{ color: "var(--ink-3)" }}>{label}</dt>
        <dd style={{ margin: 0, minWidth: 0 }}>{value}</dd>
      </div>
    ) : null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {returnError && (
        <Banner tone="bad" title={tx("Meta Ads wasn't connected", "لم تُربط إعلانات Meta")} action={<button type="button" className="btn ghost sm" onClick={() => setReturnError(null)}>{tx("Dismiss", "إغلاق")}</button>}>
          {returnError}
        </Banner>
      )}
      {conn.status === "needs_reconnect" && (
        <Banner
          tone="bad"
          title={tx("Meta Ads needs reconnecting", "إعلانات Meta تحتاج إلى إعادة ربط")}
          action={
            canManage ? (
              <button type="button" className="btn primary sm" onClick={oauth.start} disabled={oauth.busy}>
                {tx("Reconnect", "إعادة الربط")}
              </button>
            ) : undefined
          }
        >
          {reason ?? tx("Meta refused our access.", "رفضت Meta وصولنا.")}{" "}
          {tx("Spend stays Unknown until it is reconnected.", "يبقى الإنفاق غير معروف حتى تُعاد عملية الربط.")}
        </Banner>
      )}
      {canManage && !conn.config.ready && missing.length > 0 && <SetupChecklist missing={missing} tx={tx} />}
      {!canManage && !conn.config.ready && conn.status === "not_connected" && (
        <Banner tone="info">
          {tx("Meta Ads isn't available yet. Ask an administrator to set it up.", "إعلانات Meta غير متاحة بعد. اطلب من المسؤول إعدادها.")}
        </Banner>
      )}
      {oauth.error && (
        <Banner tone="bad">
          {oauth.error.text}
          {canManage && oauth.error.missing.length > 0 && (
            <div style={{ marginBlockStart: 4 }}>
              {oauth.error.missing.map((m, i) => (
                <span key={m}>
                  {i > 0 && ", "}
                  <code className="mono" dir="ltr">{m}</code>
                </span>
              ))}
            </div>
          )}
        </Banner>
      )}

      <section style={{ padding: 16, border: "1px solid var(--line-soft)", borderRadius: 12, background: "var(--bg-1)", display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ fontSize: 15, fontWeight: 650 }}>{tx("Meta Ads", "إعلانات Meta")}</div>
          <Badge kind={BADGE[view.tone]} dot>
            {view.label}
          </Badge>
          {view.firstSyncPending && (
            <span className="muted" style={{ fontSize: 12 }}>
              {tx("First sync pending: spend appears within the hour.", "المزامنة الأولى قيد الانتظار: يظهر الإنفاق خلال ساعة.")}
            </span>
          )}
        </div>

        {conn.status === "not_connected" || conn.status === "disconnected" ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>
            {tx(
              "Connect your Meta ad account to see what each click-to-WhatsApp ad spent and what each conversation cost. Without it, spend shows as Unknown.",
              "اربط حسابك الإعلاني في Meta لترى ما أنفقه كل إعلان نقر للمراسلة على واتساب وتكلفة كل محادثة. بدونه يظهر الإنفاق غير معروف.",
            )}
          </p>
        ) : (
          <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "6px 16px", margin: 0, fontSize: 12.5 }}>
            {row(
              tx("Ad account", "الحساب الإعلاني"),
              conn.adAccountId && (
                <>
                  <bdi dir="auto">{conn.adAccountName ?? ""}</bdi> <bdi className="mono" style={{ color: "var(--ink-3)" }}>{conn.adAccountId}</bdi>
                </>
              ),
            )}
            {row(tx("Currency", "العملة"), conn.currency && <bdi className="mono">{conn.currency}</bdi>)}
            {row(tx("Time zone", "المنطقة الزمنية"), conn.timezone && <bdi dir="ltr">{conn.timezone}</bdi>)}
            {row(tx("Page", "الصفحة"), conn.pageId ? <bdi dir="auto">{conn.pageName ?? conn.pageId}</bdi> : conn.adAccountId ? tx("None", "لا شيء") : null)}
            {row(
              tx("Connected", "تاريخ الربط"),
              fmtWhen(conn.connectedAt, lang) && (
                <>
                  <bdi>{fmtWhen(conn.connectedAt, lang)}</bdi>
                  {conn.connectedBy && (
                    <>
                      {tx(" by ", " بواسطة ")}
                      <bdi dir="auto">{conn.connectedBy.name}</bdi>
                    </>
                  )}
                </>
              ),
            )}
            {row(
              tx("Last sync", "آخر مزامنة"),
              conn.lastSyncedAt ? <bdi>{fmtWhen(conn.lastSyncedAt, lang)}</bdi> : conn.status === "active" ? tx("Pending", "قيد الانتظار") : null,
            )}
            {row(tx("Sync problem", "مشكلة المزامنة"), syncError && <span style={{ color: "var(--warn)" }}>{syncError}</span>)}
            {row(
              tx("History", "السجل"),
              conn.status === "active" && !conn.spendBackfilled
                ? tx("Loading the last 90 days of spend…", "جارٍ تحميل إنفاق آخر 90 يومًا…")
                : null,
            )}
            {row(tx("Login expires", "ينتهي تسجيل الدخول"), conn.tokenExpiresAt && <bdi>{fmtWhen(conn.tokenExpiresAt, lang)}</bdi>)}
          </dl>
        )}

        <ErrorText>{actionError}</ErrorText>

        {canManage && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {conn.hasPendingLogin && conn.status !== "active" && (
              <button type="button" className="btn primary" onClick={() => setPicking(true)}>
                {tx("Choose ad account", "اختر الحساب الإعلاني")}
              </button>
            )}
            <button
              type="button"
              className={`btn ${connected || conn.hasPendingLogin ? "" : "primary"}`.trim()}
              onClick={oauth.start}
              disabled={oauth.busy || (!conn.config.ready && missing.length > 0)}
            >
              {oauth.busy
                ? tx("Opening Meta…", "جارٍ فتح Meta…")
                : connected
                  ? tx("Change", "تغيير")
                  : tx("Connect Meta Ads", "ربط إعلانات Meta")}
            </button>
            {connected && (
              <button type="button" className="btn" onClick={check} disabled={busy !== null || cooldownLeft > 0}>
                {busy === "check"
                  ? tx("Checking…", "جارٍ الفحص…")
                  : cooldownLeft > 0
                    ? tx(`Check again in ${cooldownLeft} s`, `افحص مجددًا بعد ${cooldownLeft} ث`)
                    : tx("Check now", "افحص الآن")}
              </button>
            )}
            {connected && (
              <button type="button" className="btn danger" onClick={() => setConfirmDisconnect(true)} disabled={busy !== null}>
                {tx("Disconnect", "فصل")}
              </button>
            )}
          </div>
        )}
      </section>

      {picking && canManage && (
        <CandidatePicker
          tx={tx}
          lang={lang}
          current={conn}
          onClose={() => setPicking(false)}
          onSaved={(dto) => {
            setConn(dto);
            setPicking(false);
            toast(tx("Meta Ads connected.", "تم ربط إعلانات Meta."), "success");
          }}
          onReconnect={oauth.start}
        />
      )}

      {confirmDisconnect && (
        <div dir={lang === "ar" ? "rtl" : "ltr"}>
          <ConfirmDialog
            title={tx("Disconnect Meta Ads?", "فصل إعلانات Meta؟")}
            body={
              <>
                <p style={{ margin: "0 0 8px" }}>
                  {tx(
                    "We stop reading spend and delete the stored login. Spend and conversations already recorded are kept, and new spend will show as Unknown.",
                    "نتوقف عن قراءة الإنفاق ونحذف تسجيل الدخول المحفوظ. يبقى الإنفاق والمحادثات المسجلة، ويظهر الإنفاق الجديد غير معروف.",
                  )}
                </p>
                <p style={{ margin: 0 }}>
                  {tx(
                    "To revoke our access completely, remove the app in Meta Business Settings → Integrations.",
                    "لإلغاء وصولنا بالكامل، أزل التطبيق من إعدادات الأعمال في Meta ← عمليات التكامل.",
                  )}
                </p>
              </>
            }
            confirmLabel={tx("Disconnect", "فصل")}
            danger
            busy={busy === "disconnect"}
            error={actionError}
            tx={tx}
            onConfirm={disconnect}
            onClose={() => setConfirmDisconnect(false)}
          />
        </div>
      )}
    </div>
  );
}

function CandidatePicker({
  tx,
  lang,
  current,
  onClose,
  onSaved,
  onReconnect,
}: {
  tx: Tx;
  lang: Lang;
  current: MetaAdsConnectionDto;
  onClose: () => void;
  onSaved: (dto: MetaAdsConnectionDto) => void;
  onReconnect: () => void;
}) {
  // A fresh read per opening: the pending login changes with every Meta round trip.
  const [openedAt] = useState(() => Date.now());
  const candQ = useFetch<MetaAdsCandidates>("/meta-ads/candidates", { key: openedAt });
  const cand = candQ.data;
  const [account, setAccount] = useState<string | null>(current.adAccountId);
  const [page, setPage] = useState<string | null>(current.pageId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cand) return;
    if (!cand.adAccounts.some((a) => a.id === account)) setAccount(cand.adAccounts.length === 1 ? cand.adAccounts[0].id : null);
    if (page && !cand.pages.some((p) => p.id === page)) setPage(null);
    // eslint-disable-next-line
  }, [cand]);

  const save = async () => {
    if (!account) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.post<MetaAdsConnectionDto>(CONNECTION_PATH, { adAccountId: account, pageId: page }));
    } catch (e) {
      setError(adsErrorText(e, tx));
      setSaving(false);
    }
  };

  const loadError = candQ.error;
  const expired = loadError === "meta_ads.login_expired" || loadError === "meta_ads.not_exchanged" || loadError === "meta_ads.reconnect";
  const radioRow: React.CSSProperties = { display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 4px", fontSize: 13, cursor: "pointer" };

  return (
    <Modal onClose={saving ? () => {} : onClose} label={tx("Choose your ad account", "اختر حسابك الإعلاني")} width={520}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 650 }}>{tx("Choose your ad account", "اختر حسابك الإعلاني")}</div>
        {!cand && !loadError && <Skeleton h={120} />}
        {loadError && (
          <Banner
            tone="bad"
            action={
              expired ? (
                <button type="button" className="btn sm primary" onClick={onReconnect}>
                  {tx("Connect again", "اربط مجددًا")}
                </button>
              ) : undefined
            }
          >
            {adsErrorText(loadError, tx)}
          </Banner>
        )}
        {cand && (
          <>
            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend style={{ fontSize: 12, fontWeight: 650, color: "var(--ink-3)", marginBlockEnd: 4 }}>{tx("Ad account", "الحساب الإعلاني")}</legend>
              {cand.adAccounts.length === 0 && (
                <div className="muted" style={{ fontSize: 12.5 }}>
                  {tx("This login can't see any ad account.", "تسجيل الدخول هذا لا يرى أي حساب إعلاني.")}
                </div>
              )}
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                {cand.adAccounts.map((a) => (
                  <label key={a.id} style={radioRow}>
                    <input type="radio" name="meta-ad-account" checked={account === a.id} onChange={() => setAccount(a.id)} />
                    <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
                      <bdi dir="auto" style={{ fontWeight: 600 }}>{a.name || a.id}</bdi>
                      <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                        <bdi className="mono">{a.id}</bdi> · <bdi className="mono">{a.currency}</bdi> · <bdi dir="ltr">{a.timezone}</bdi>
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
              <legend style={{ fontSize: 12, fontWeight: 650, color: "var(--ink-3)", marginBlockEnd: 4 }}>
                {tx("Facebook Page (optional)", "صفحة فيسبوك (اختياري)")}
              </legend>
              <div style={{ maxHeight: 160, overflowY: "auto" }}>
                <label style={radioRow}>
                  <input type="radio" name="meta-page" checked={page === null} onChange={() => setPage(null)} />
                  {tx("None", "لا شيء")}
                </label>
                {cand.pages.map((p) => (
                  <label key={p.id} style={radioRow}>
                    <input type="radio" name="meta-page" checked={page === p.id} onChange={() => setPage(p.id)} />
                    <bdi dir="auto">{p.name || p.id}</bdi>
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}
        <ErrorText>{error}</ErrorText>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="button" className="btn primary" onClick={save} disabled={!account || saving}>
            {saving ? tx("Saving…", "جارٍ الحفظ…") : tx("Save", "حفظ")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
