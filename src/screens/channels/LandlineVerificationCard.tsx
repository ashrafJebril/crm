import { useEffect, useState } from "react";
import { api, ApiError } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { ChannelDto, Lang } from "@/lib/types";
import { channelErrorText, errorExtras } from "./channelErrors";
import { landlineView } from "./channelModel";
import { ErrorText, LabeledField, fieldInput } from "./channelUi";

/**
 * Drives a pending Meta number through `config.verification.stage`:
 *  needs_number → POST landline/number {cc, phoneNumber, verifiedName}
 *  awaiting_code → POST landline/request-code {method, language} (60 s cooldown,
 *                  counted down here) and POST landline/verify {code}
 *  needs_registration → POST landline/register
 * Each step returns the updated channel; the stage on it moves the card on.
 */
export function LandlineVerificationCard({
  channel,
  tx,
  lang,
  canEdit,
  onUpdated,
}: {
  channel: ChannelDto;
  tx: Tx;
  lang: Lang;
  canEdit: boolean;
  onUpdated: (c: ChannelDto) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [resendOverride, setResendOverride] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ text: string; soft: boolean } | null>(null);
  const [cc, setCc] = useState("966");
  const [phone, setPhone] = useState("");
  const [verifiedName, setVerifiedName] = useState(channel.displayName ?? "");
  const [method, setMethod] = useState<"VOICE" | "SMS">("VOICE");
  const [callLang, setCallLang] = useState(lang === "ar" ? "ar" : "en_US");
  const [code, setCode] = useState("");

  const view = landlineView(channel, now, resendOverride);
  const coolingDown = (view?.secondsLeft ?? 0) > 0;

  useEffect(() => {
    if (!coolingDown) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [coolingDown]);

  // A new stage or resendAt from the server restarts the clock.
  useEffect(() => {
    setNow(Date.now());
  }, [channel.config?.verification?.stage, channel.config?.verification?.resendAt]);

  if (!view) return null;

  const base = `/channels/${encodeURIComponent(channel.id)}/landline`;
  const run = async (key: string, path: string, body?: unknown) => {
    setBusy(key);
    setError(null);
    try {
      const next = await api.post<ChannelDto>(`${base}/${path}`, body);
      setResendOverride(null);
      onUpdated(next);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.message === "channels.landline_cooldown") {
        const x = errorExtras(e);
        const at =
          typeof x.resendAt === "string"
            ? x.resendAt
            : Number(x.retryAfter) > 0
              ? new Date(Date.now() + Number(x.retryAfter) * 1000).toISOString()
              : null;
        if (at) setResendOverride(at);
        setNow(Date.now());
      }
      const soft = e instanceof ApiError && (e.message === "channels.landline_rate_limited" || e.message === "channels.landline_cooldown");
      setError({ text: channelErrorText(e, tx), soft });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const box = {
    display: "grid",
    gap: 12,
    padding: 14,
    borderRadius: 10,
    border: "1px solid color-mix(in oklch, var(--accent) 35%, transparent)",
  } as const;

  return (
    <section aria-label={tx("Verify the number", "التحقق من الرقم")} data-stage={view.stage} style={box}>
      {view.step === "number" && (
        <>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{tx("Add your WhatsApp number", "أضِف رقم واتساب")}</div>
            <div className="muted" style={{ fontSize: 12, marginBlockStart: 2, lineHeight: 1.5 }}>
              {tx(
                "Your WhatsApp Business account is connected. Add the number your customers will message; a landline works.",
                "تم ربط حساب واتساب للأعمال. أضِف الرقم الذي سيراسله عملاؤك، ويمكن أن يكون هاتفًا ثابتًا.",
              )}
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 10 }}>
            <LabeledField label={tx("Country code", "رمز الدولة")}>
              <input dir="ltr" inputMode="numeric" maxLength={5} value={cc} disabled={!canEdit} onChange={(e) => setCc(e.target.value)} style={fieldInput} />
            </LabeledField>
            <LabeledField label={tx("Phone number", "رقم الهاتف")}>
              <input dir="ltr" inputMode="tel" maxLength={30} value={phone} disabled={!canEdit} onChange={(e) => setPhone(e.target.value)} style={fieldInput} />
            </LabeledField>
          </div>
          <LabeledField
            label={tx("Display name", "الاسم الظاهر")}
            hint={tx("Customers see this name in WhatsApp. Meta reviews it, so use your business name.", "يرى العملاء هذا الاسم في واتساب. تراجعه Meta، فاستخدم اسم نشاطك التجاري.")}
          >
            <input dir="auto" maxLength={120} value={verifiedName} disabled={!canEdit} onChange={(e) => setVerifiedName(e.target.value)} style={fieldInput} />
          </LabeledField>
          <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--warn)" }}>
            {tx(
              "This number must not be active on the WhatsApp or WhatsApp Business app. If it is, delete that account in the app first.",
              "يجب ألا يكون الرقم مفعّلًا على تطبيق واتساب أو واتساب للأعمال. إن كان كذلك فاحذف الحساب من التطبيق أولًا.",
            )}
          </div>
          {canEdit && (
            <button
              type="button"
              className="btn primary"
              style={{ justifySelf: "start" }}
              disabled={!!busy || !cc.trim() || !phone.trim() || !verifiedName.trim()}
              onClick={() => run("number", "number", { cc: cc.trim(), phoneNumber: phone.trim(), verifiedName: verifiedName.trim() })}
            >
              {busy === "number" ? tx("Saving…", "جارٍ الحفظ…") : tx("Save number", "حفظ الرقم")}
            </button>
          )}
        </>
      )}

      {view.step === "code" && (
        <>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{tx("Verify your number", "تحقّق من رقمك")}</div>
            {view.phone && (
              <div className="muted" style={{ fontSize: 12, marginBlockStart: 2 }}>
                {tx("Meta will send a 6-digit code to ", "سترسل Meta رمزًا من 6 أرقام إلى ")}
                <bdi dir="ltr">{view.phone}</bdi>.
              </div>
            )}
          </div>
          <ul style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 3, fontSize: 12, lineHeight: 1.5, color: "var(--ink-2)" }}>
            <li>{tx("Make sure someone can answer this number in the next 10 minutes.", "تأكد أن أحدًا يستطيع الرد على هذا الرقم خلال 10 دقائق.")}</li>
            <li>
              {tx(
                "On a switchboard, route the number to an extension someone is watching, or forward it to a mobile.",
                "إن كان الرقم على سنترال، وجّهه إلى تحويلة يراقبها أحد، أو حوّله إلى جوال.",
              )}
            </li>
          </ul>
          {canEdit && (
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <LabeledField label={tx("Method", "الطريقة")}>
                <select value={method} onChange={(e) => setMethod(e.target.value as "VOICE" | "SMS")} style={{ ...fieldInput, width: 150 }}>
                  <option value="VOICE">{tx("Voice call", "مكالمة صوتية")}</option>
                  <option value="SMS">{tx("SMS", "رسالة نصية")}</option>
                </select>
              </LabeledField>
              <LabeledField label={tx("Language", "اللغة")}>
                <select value={callLang} onChange={(e) => setCallLang(e.target.value)} style={{ ...fieldInput, width: 140 }}>
                  <option value="ar">العربية</option>
                  <option value="en_US">English</option>
                </select>
              </LabeledField>
              <button
                type="button"
                className="btn"
                disabled={!!busy || coolingDown}
                aria-live="polite"
                onClick={() => run("request", "request-code", { method, language: callLang })}
              >
                {busy === "request"
                  ? tx("Requesting…", "جارٍ الطلب…")
                  : coolingDown
                    ? tx(`Request again in ${view.secondsLeft}s`, `طلب جديد بعد ${view.secondsLeft} ث`)
                    : method === "VOICE"
                      ? tx("Call me now", "اتصل بي الآن")
                      : tx("Send the code", "أرسل الرمز")}
              </button>
            </div>
          )}
          {canEdit && (
            <form
              style={{ display: "flex", gap: 10, alignItems: "flex-end" }}
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run("verify", "verify", { code: code.trim() })) setCode("");
              }}
            >
              <LabeledField label={tx("Verification code", "رمز التحقق")}>
                <input
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  style={{ ...fieldInput, width: 140, fontFamily: "var(--font-mono)", letterSpacing: 2 }}
                />
              </LabeledField>
              <button type="submit" className="btn primary" disabled={!!busy || !/^\d{6}$/.test(code)}>
                {busy === "verify" ? tx("Verifying…", "جارٍ التحقق…") : tx("Verify", "تحقّق")}
              </button>
            </form>
          )}
          <div className="muted" style={{ fontSize: 11.5 }}>
            {tx("Not ready? You can leave. The number is saved and waits here.", "لست جاهزًا؟ يمكنك المغادرة. الرقم محفوظ وينتظرك هنا.")}
          </div>
        </>
      )}

      {view.step === "register" && (
        <>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13.5 }}>{tx("Finish connecting this number", "أكمل ربط هذا الرقم")}</div>
            <div className="muted" style={{ fontSize: 12, marginBlockStart: 2, lineHeight: 1.5 }}>
              {tx(
                "Meta verified this number but hasn't finished registering it for WhatsApp. Try again; if it keeps failing, contact support.",
                "تحققت Meta من هذا الرقم لكنها لم تُكمل تسجيله في واتساب. حاول مرة أخرى، وإن تكرر الفشل فتواصل مع الدعم.",
              )}
            </div>
          </div>
          {canEdit && (
            <button type="button" className="btn primary" style={{ justifySelf: "start" }} disabled={!!busy} onClick={() => run("register", "register")}>
              {busy === "register" ? tx("Registering…", "جارٍ التسجيل…") : tx("Try again", "حاول مرة أخرى")}
            </button>
          )}
        </>
      )}

      {!canEdit && (
        <div className="muted" style={{ fontSize: 11.5 }}>
          {tx("Only members who can manage channels can finish this step.", "يمكن فقط للأعضاء الذين يديرون القنوات إكمال هذه الخطوة.")}
        </div>
      )}

      {error &&
        (error.soft ? (
          <div role="alert" style={{ fontSize: 12.5, lineHeight: 1.5, padding: 10, borderRadius: 8, background: "color-mix(in oklch, var(--warn) 12%, transparent)" }}>
            {error.text}
          </div>
        ) : (
          <ErrorText>{error.text}</ErrorText>
        ))}
    </section>
  );
}
