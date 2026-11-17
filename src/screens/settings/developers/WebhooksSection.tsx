import { useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { Badge } from "@/components/Badge";
import { Modal } from "@/components/Modal";
import type { WebhookDelivery, WebhookEndpoint } from "@/lib/types";
import type { Tx } from "@/lib/tx";
import { ErrorRow, Field, SettingsCard, StatusToast, inputStyle } from "../form";
import {
  ROTATION_OVERLAP_HOURS,
  WEBHOOK_EVENTS,
  deliveryStatusLabel,
  deliveryTone,
  disabledReasonText,
  eventLabel,
  lastErrorText,
  looksLikeHttpsUrl,
  shortDate,
} from "./apiModel";
import { developerErrorText } from "./developerErrors";
import { ShownOnce } from "./ShownOnce";
import { SHOWN_ONCE_CLOSE_CONFIRM, guardedClose, modalDismissible } from "./shownOnceGuard";

const MONO = { fontFamily: "var(--mono)", fontSize: 12 } as const;

interface Caps {
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  /** Impersonation: no create, no rotate (the server refuses both). */
  impersonating: boolean;
}

/**
 * SP-27 outgoing webhooks: endpoints (URL fixed after create, events,
 * description, on/off), the signing secret shown once at create and rotate
 * (the old secret keeps signing for 24 h), "Send test", the delivery log with
 * redeliver, and the disabled state with its reason.
 */
export function WebhooksSection({ tx, lang, caps }: { tx: Tx; lang: "en" | "ar"; caps: Caps }) {
  const q = useFetch<{ items: WebhookEndpoint[] }>("/webhooks");
  const [dialog, setDialog] = useState<{ mode: "create" } | { mode: "edit"; ep: WebhookEndpoint } | null>(null);
  const [secret, setSecret] = useState<{ value: string; rotated: boolean; copied?: boolean } | null>(null);
  // Review M1: an uncopied signing secret survives Escape and backdrop clicks; Done asks first.
  const closeSecret = () =>
    guardedClose(
      { secretShown: secret !== null, copied: secret?.copied === true },
      () => setSecret(null),
      (m) => window.confirm(m),
      tx(...SHOWN_ONCE_CLOSE_CONFIRM),
    );
  const [log, setLog] = useState<WebhookEndpoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (m: string) => {
    setToast(m);
    window.setTimeout(() => setToast(null), 2400);
  };
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    try {
      await fn();
      await q.refetch();
      if (done) flash(done);
    } catch (e) {
      setError(developerErrorText(e, tx));
    }
  };

  const rotate = (ep: WebhookEndpoint) =>
    run(async () => {
      if (
        !window.confirm(
          tx(
            `Create a new signing secret? The current one keeps signing for ${ROTATION_OVERLAP_HOURS} hours, so you can update your receiver without missing deliveries.`,
            `إنشاء سر توقيع جديد؟ سيستمر السر الحالي في التوقيع لمدة ${ROTATION_OVERLAP_HOURS} ساعة، لتتمكن من تحديث المستقبِل دون فقدان أي تسليم.`,
          ),
        )
      ) {
        return;
      }
      const res = await api.post<{ secret: string }>(`/webhooks/${encodeURIComponent(ep.id)}/rotate-secret`);
      setSecret({ value: res.secret, rotated: true });
    });

  const remove = (ep: WebhookEndpoint) =>
    run(async () => {
      if (!window.confirm(tx("Delete this webhook and its delivery log?", "حذف هذا الويب هوك وسجل التسليم الخاص به؟"))) return;
      await api.delete(`/webhooks/${encodeURIComponent(ep.id)}`);
    }, tx("Webhook deleted.", "تم حذف الويب هوك."));

  const test = (ep: WebhookEndpoint) =>
    run(() => api.post(`/webhooks/${encodeURIComponent(ep.id)}/test`), tx("Test ping queued. It is sent within a few seconds.", "تمت جدولة الاختبار، وسيُرسل خلال ثوانٍ."));

  const items = q.data?.items ?? [];
  const canCreate = caps.canCreate && !caps.impersonating;

  return (
    <>
      <SettingsCard
        title={tx("Webhooks", "الويب هوكس")}
        description={tx(
          "Send events (new contacts, messages, tickets, bookings) to your own https endpoint, signed so you can verify they came from us.",
          "أرسل الأحداث (جهات اتصال ورسائل وتذاكر وحجوزات جديدة) إلى نقطة https خاصة بك، موقّعة لتتحقق من أنها منا.",
        )}
        footer={
          canCreate ? (
            <button type="button" className="btn primary" onClick={() => setDialog({ mode: "create" })}>
              {tx("Add webhook", "إضافة ويب هوك")}
            </button>
          ) : undefined
        }
      >
        {q.loading && !q.data ? (
          <div className="muted" style={{ fontSize: 12 }}>
            {tx("Loading…", "جارٍ التحميل…")}
          </div>
        ) : items.length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5 }}>
            {tx("No webhooks yet.", "لا توجد ويب هوكس بعد.")}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {items.map((ep) => {
              const off = disabledReasonText(ep, tx);
              return (
                <div key={ep.id} style={{ display: "grid", gap: 6, padding: "10px 12px", border: "1px solid var(--line-soft)", borderRadius: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <bdi dir="ltr" style={{ ...MONO, overflowWrap: "anywhere" }}>
                      {ep.url}
                    </bdi>
                    <Badge kind={ep.active ? "ok" : ep.disabledReason === "manual" ? "" : "bad"}>
                      {ep.active ? tx("On", "مفعّل") : tx("Off", "متوقف")}
                    </Badge>
                    {ep.hasPreviousSecret && <Badge kind="info">{tx("Rotating secret", "تدوير السر جارٍ")}</Badge>}
                  </div>
                  {ep.description && (
                    <div dir="auto" style={{ fontSize: 12, color: "var(--ink-2)" }}>
                      {ep.description}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {ep.events.map((e) => (
                      <Badge key={e} kind="">
                        {eventLabel(e, tx)}
                      </Badge>
                    ))}
                  </div>
                  {off && (
                    <div role="status" style={{ fontSize: 12, color: ep.disabledReason === "manual" ? "var(--ink-3)" : "var(--bad)" }}>
                      {off}
                    </div>
                  )}
                  {ep.active && ep.failingSince && (
                    <div style={{ fontSize: 12, color: "var(--warn)" }}>
                      {tx(
                        `Deliveries have been failing since ${shortDate(ep.failingSince, lang)}. After 72 hours of failures it is turned off.`,
                        `يفشل التسليم منذ ${shortDate(ep.failingSince, lang)}. بعد 72 ساعة من الفشل يتم إيقافه.`,
                      )}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button type="button" className="btn ghost sm" onClick={() => setLog(ep)}>
                      {tx("Delivery log", "سجل التسليم")}
                    </button>
                    {caps.canUpdate && (
                      <>
                        <button type="button" className="btn ghost sm" disabled={!ep.active} onClick={() => void test(ep)}>
                          {tx("Send test", "إرسال اختبار")}
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => setDialog({ mode: "edit", ep })}>
                          {tx("Edit", "تعديل")}
                        </button>
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => void run(() => api.patch(`/webhooks/${encodeURIComponent(ep.id)}`, { active: !ep.active }))}
                        >
                          {ep.active ? tx("Turn off", "إيقاف") : tx("Turn on", "تفعيل")}
                        </button>
                        {!caps.impersonating && (
                          <button type="button" className="btn ghost sm" onClick={() => void rotate(ep)}>
                            {tx("Rotate secret", "تدوير السر")}
                          </button>
                        )}
                      </>
                    )}
                    {caps.canDelete && (
                      <button type="button" className="btn ghost sm" onClick={() => void remove(ep)}>
                        {tx("Delete", "حذف")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="muted" style={{ fontSize: 11.5 }}>
          {tx(
            "Each request carries X-Crm-Signature: t=<time>,v1=<HMAC-SHA256 of t.body>. Reject signatures older than 5 minutes.",
            "يحمل كل طلب X-Crm-Signature: t=<الوقت>,v1=<HMAC-SHA256 لـ t.body>. ارفض التواقيع الأقدم من 5 دقائق.",
          )}
        </div>
        <ErrorRow message={q.error ?? error} />
      </SettingsCard>

      {dialog && (
        <WebhookDialog
          tx={tx}
          lang={lang}
          ep={dialog.mode === "edit" ? dialog.ep : null}
          onClose={() => setDialog(null)}
          onSaved={(s) => {
            setDialog(null);
            void q.refetch();
            if (s) setSecret({ value: s, rotated: false });
          }}
        />
      )}
      {secret && (
        <Modal
          onClose={closeSecret}
          dismissible={modalDismissible({ secretShown: true, copied: secret.copied === true })}
          width={560}
          label={tx("Signing secret", "سر التوقيع")}
        >
          <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Signing secret", "سر التوقيع")}</div>
            <ShownOnce
              value={secret.value}
              tx={tx}
              label={tx("Signing secret", "سر التوقيع")}
              onCopied={() => setSecret((s) => (s ? { ...s, copied: true } : s))}
            />
            {secret.rotated && (
              <div className="muted" style={{ fontSize: 12 }}>
                {tx(
                  `For the next ${ROTATION_OVERLAP_HOURS} hours each delivery is signed with both the old and the new secret (two v1 values). Update your receiver within that time.`,
                  `خلال الـ ${ROTATION_OVERLAP_HOURS} ساعة القادمة يُوقَّع كل تسليم بالسر القديم والجديد معًا (قيمتا v1). حدّث المستقبِل خلال هذه المدة.`,
                )}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button type="button" className="btn primary" onClick={closeSecret}>
                {tx("Done", "تم")}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {log && <WebhookDeliveries tx={tx} lang={lang} ep={log} canRedeliver={caps.canUpdate} onClose={() => setLog(null)} />}
      <StatusToast message={toast} />
    </>
  );
}

function WebhookDialog({
  tx,
  lang,
  ep,
  onClose,
  onSaved,
}: {
  tx: Tx;
  lang: "en" | "ar";
  ep: WebhookEndpoint | null;
  onClose: () => void;
  onSaved: (secret: string | null) => void;
}) {
  const [url, setUrl] = useState(ep?.url ?? "");
  const [events, setEvents] = useState<string[]>(ep?.events ?? []);
  const [description, setDescription] = useState(ep?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlOk = ep !== null || looksLikeHttpsUrl(url);
  const valid = urlOk && events.length > 0 && description.length <= 200;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (ep) {
        await api.patch(`/webhooks/${encodeURIComponent(ep.id)}`, { events, description });
        onSaved(null);
      } else {
        const res = await api.post<WebhookEndpoint & { secret: string }>("/webhooks", {
          url: url.trim(),
          events,
          ...(description.trim() ? { description: description.trim() } : {}),
        });
        onSaved(res.secret);
      }
    } catch (e) {
      setError(developerErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} width={560} label={ep ? tx("Edit webhook", "تعديل الويب هوك") : tx("Add webhook", "إضافة ويب هوك")}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{ep ? tx("Edit webhook", "تعديل الويب هوك") : tx("Add webhook", "إضافة ويب هوك")}</div>
        <Field
          label={tx("Endpoint URL", "رابط نقطة الاستقبال")}
          hint={
            ep
              ? tx("The URL can't be changed. To use another URL, delete this webhook and add a new one.", "لا يمكن تغيير الرابط. لاستخدام رابط آخر، احذف هذا الويب هوك وأضف واحدًا جديدًا.")
              : tx("A public https:// address.", "عنوان https:// عام.")
          }
        >
          <input
            dir="ltr"
            style={{ ...inputStyle, fontFamily: "var(--mono)" }}
            value={url}
            readOnly={ep !== null}
            placeholder="https://"
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        {!urlOk && url.trim() !== "" && (
          <div style={{ fontSize: 11.5, color: "var(--bad)" }}>{tx("Use a public https:// address.", "استخدم عنوان https:// عامًا.")}</div>
        )}
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 6 }}>
          <legend style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>{tx("Events", "الأحداث")}</legend>
          {WEBHOOK_EVENTS.map((e) => (
            <label key={e} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={events.includes(e)}
                onChange={(x) => setEvents((cur) => (x.target.checked ? [...cur, e] : cur.filter((y) => y !== e)))}
              />
              {eventLabel(e, tx)}
              <bdi dir="ltr" style={{ ...MONO, color: "var(--ink-3)" }}>
                {e}
              </bdi>
            </label>
          ))}
        </fieldset>
        <Field label={tx("Description (optional)", "الوصف (اختياري)")}>
          <input dir="auto" style={inputStyle} maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <ErrorRow message={error} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="button" className="btn primary" disabled={!valid || busy} onClick={() => void submit()}>
            {ep ? tx("Save", "حفظ") : tx("Add webhook", "إضافة ويب هوك")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function WebhookDeliveries({
  tx,
  lang,
  ep,
  canRedeliver,
  onClose,
}: {
  tx: Tx;
  lang: "en" | "ar";
  ep: WebhookEndpoint;
  canRedeliver: boolean;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<"" | "pending" | "delivered" | "failed">("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<WebhookDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (cursor) qs.set("cursor", cursor);
  const path = `/webhooks/${encodeURIComponent(ep.id)}/deliveries${qs.toString() ? `?${qs}` : ""}`;
  const q = useFetch<{ items: WebhookDelivery[]; nextCursor: string | null }>(path);

  const view = async (d: WebhookDelivery) => {
    setError(null);
    try {
      setOpen(await api.get<WebhookDelivery>(`/webhooks/${encodeURIComponent(ep.id)}/deliveries/${encodeURIComponent(d.id)}`));
    } catch (e) {
      setError(developerErrorText(e, tx));
    }
  };
  const redeliver = async (d: WebhookDelivery) => {
    setError(null);
    try {
      await api.post(`/webhooks/${encodeURIComponent(ep.id)}/deliveries/${encodeURIComponent(d.id)}/redeliver`);
      await q.refetch();
    } catch (e) {
      setError(developerErrorText(e, tx));
    }
  };

  return (
    <Modal onClose={onClose} width={760} label={tx("Delivery log", "سجل التسليم")}>
      <div dir={lang === "ar" ? "rtl" : "ltr"} style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("Delivery log", "سجل التسليم")}</div>
          <bdi dir="ltr" style={{ ...MONO, color: "var(--ink-3)", overflowWrap: "anywhere" }}>
            {ep.url}
          </bdi>
        </div>
        <div role="group" aria-label={tx("Filter", "تصفية")} style={{ display: "flex", gap: 6 }}>
          {(
            [
              ["", tx("All", "الكل")],
              ["delivered", tx("Delivered", "تم التسليم")],
              ["pending", tx("Pending or retrying", "قيد الانتظار أو إعادة المحاولة")],
              ["failed", tx("Failed", "فشل")],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v || "all"}
              type="button"
              className={`btn sm ${status === v ? "primary" : "ghost"}`}
              aria-pressed={status === v}
              onClick={() => {
                setStatus(v);
                setCursor(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {q.loading && !q.data ? (
          <div className="muted" style={{ fontSize: 12 }}>
            {tx("Loading…", "جارٍ التحميل…")}
          </div>
        ) : (q.data?.items ?? []).length === 0 ? (
          <div className="muted" style={{ fontSize: 12.5 }}>
            {tx("No deliveries.", "لا توجد عمليات تسليم.")}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6, maxHeight: 380, overflowY: "auto" }}>
            {(q.data?.items ?? []).map((d) => (
              <div key={d.id} style={{ display: "grid", gap: 2, padding: "8px 10px", border: "1px solid var(--line-soft)", borderRadius: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge kind={deliveryTone(d)}>{deliveryStatusLabel(d, tx)}</Badge>
                  <span style={{ fontSize: 12.5 }}>{eventLabel(d.event, tx)}</span>
                  {d.responseCode !== null && (
                    <bdi dir="ltr" style={MONO}>
                      HTTP {d.responseCode}
                    </bdi>
                  )}
                  <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {tx(`Attempts: ${d.attempts}`, `المحاولات: ${d.attempts}`)} · {shortDate(d.createdAt, lang)}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button type="button" className="btn ghost sm" onClick={() => void view(d)}>
                    {tx("Payload", "المحتوى")}
                  </button>
                  {canRedeliver && d.status !== "pending" && (
                    <button type="button" className="btn ghost sm" onClick={() => void redeliver(d)}>
                      {tx("Redeliver", "إعادة الإرسال")}
                    </button>
                  )}
                </div>
                {lastErrorText(d.lastError, tx) && <div style={{ fontSize: 11.5, color: "var(--ink-2)" }}>{lastErrorText(d.lastError, tx)}</div>}
                {d.status === "pending" && d.attempts > 0 && (
                  <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
                    {tx(`Next try: ${shortDate(d.nextAttemptAt, lang)}`, `المحاولة التالية: ${shortDate(d.nextAttemptAt, lang)}`)}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {open && (
          <pre
            dir="ltr"
            style={{ ...MONO, maxHeight: 260, overflow: "auto", padding: 10, background: "var(--bg-2)", borderRadius: 8, margin: 0 }}
          >
            {JSON.stringify(open.payload, null, 2)}
          </pre>
        )}
        <ErrorRow message={q.error ?? error} />
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <button type="button" className="btn ghost" disabled={!cursor} onClick={() => setCursor(null)}>
            {tx("First page", "الصفحة الأولى")}
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {q.data?.nextCursor && (
              <button type="button" className="btn ghost" onClick={() => setCursor(q.data?.nextCursor ?? null)}>
                {tx("Older", "الأقدم")}
              </button>
            )}
            <button type="button" className="btn primary" onClick={onClose}>
              {tx("Close", "إغلاق")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
