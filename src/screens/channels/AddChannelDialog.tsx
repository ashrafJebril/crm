import { useState } from "react";
import { api } from "@/api/client";
import { Modal } from "@/components/Modal";
import type { Tx } from "@/lib/tx";
import type { ChannelDto, ChannelLimits, EmbeddedSignupConfig } from "@/lib/types";
import { useZernioConnect } from "@/screens/settings/ZernioCard";
import { channelErrorCopy, channelErrorText } from "./channelErrors";
import { kindLabel, limitState } from "./channelModel";
import { Banner, ErrorText, KindMark, LabeledField, fieldInput } from "./channelUi";
import { EmbeddedSignupButton } from "./EmbeddedSignupButton";
import { NumberLimitNotice } from "./NumberLimitNotice";
import { TelegramConnectForm } from "./TelegramConnectForm";
import { WhatsAppManualForm } from "./WhatsAppManualForm";

type Step = "pick" | "whatsapp" | "facebook" | "instagram" | "tiktok" | "telegram" | "webchat";

const KINDS: { key: Exclude<Step, "pick">; en: string; ar: string }[] = [
  { key: "whatsapp", en: "Meta signup, Zernio or an access token", ar: "تسجيل Meta أو Zernio أو رمز وصول" },
  { key: "facebook", en: "Page messages through Zernio", ar: "رسائل الصفحة عبر Zernio" },
  { key: "instagram", en: "Direct messages through Zernio", ar: "الرسائل المباشرة عبر Zernio" },
  { key: "tiktok", en: "Through Zernio", ar: "عبر Zernio" },
  { key: "telegram", en: "Your own bot", ar: "البوت الخاص بك" },
  { key: "webchat", en: "A chat bubble and a shareable chat page", ar: "زر محادثة وصفحة محادثة قابلة للمشاركة" },
];

/** Kind picker and every connect flow (SP-19 T5). */
export function AddChannelDialog({
  tx,
  limits,
  esConfig,
  canSeeConfig,
  onClose,
  onConnected,
}: {
  tx: Tx;
  limits: ChannelLimits | null;
  esConfig: EmbeddedSignupConfig | null;
  /** channels.update: sees missing env names and config warnings. */
  canSeeConfig: boolean;
  onClose: () => void;
  /** A channel was created: the hub opens it. */
  onConnected: (c: ChannelDto) => void;
}) {
  const [step, setStep] = useState<Step>("pick");
  const zernio = useZernioConnect(tx);
  const atLimit = limitState(limits) === "at_limit";
  const title = tx("Add a channel", "إضافة قناة");

  const back = (
    <button type="button" className="btn ghost sm" onClick={() => setStep("pick")} style={{ justifySelf: "start" }}>
      {tx("All channels", "كل القنوات")}
    </button>
  );

  const zernioPanel = (platform: string) => {
    const k = kindLabel(platform);
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--ink-2)" }}>
          {tx(
            `You'll sign in to ${k.en} in Zernio's secure window and choose the account. No Meta app review or token is needed. You come back here when it's done.`,
            `ستسجّل الدخول إلى ${k.ar} في نافذة Zernio الآمنة وتختار الحساب، دون مراجعة تطبيق Meta أو رمز وصول. ستعود إلى هنا عند الانتهاء.`,
          )}
        </div>
        <button
          type="button"
          className="btn primary"
          style={{ justifySelf: "start" }}
          disabled={!!zernio.busy || (platform === "whatsapp" && atLimit)}
          onClick={() => zernio.start(platform)}
        >
          {zernio.busy === platform ? tx("Opening…", "جارٍ الفتح…") : tx(`Connect ${k.en} with Zernio`, `ربط ${k.ar} عبر Zernio`)}
        </button>
        <ErrorText>{zernio.error}</ErrorText>
      </div>
    );
  };

  return (
    <Modal onClose={onClose} label={title} width={600}>
      <div style={{ display: "grid", gap: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>
          {step === "pick" ? title : tx(kindLabel(step).en, kindLabel(step).ar)}
        </div>

        {step === "pick" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {KINDS.map((k) => {
              const l = kindLabel(k.key);
              return (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => {
                    zernio.clearError();
                    setStep(k.key);
                  }}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "center",
                    padding: 12,
                    borderRadius: 10,
                    background: "var(--bg-2)",
                    border: "1px solid var(--line-soft)",
                    color: "var(--ink)",
                    textAlign: "start",
                    cursor: "pointer",
                  }}
                >
                  <KindMark kind={k.key} />
                  <span style={{ display: "grid", gap: 2 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{tx(l.en, l.ar)}</span>
                    <span className="muted" style={{ fontSize: 11.5 }}>{tx(k.en, k.ar)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {step === "whatsapp" && (
          <>
            {back}
            <NumberLimitNotice limits={limits} tx={tx} />
            {atLimit && limits && (
              <Banner tone="warn">
                {(() => {
                  const c = channelErrorCopy("channels.limit_reached", limits.whatsapp)!;
                  return tx(c.en, c.ar);
                })()}
              </Banner>
            )}
            <Section title={tx("Connect with Meta (recommended)", "الربط عبر Meta (موصى به)")}>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                {tx(
                  "Sign in with Facebook, pick or create the WhatsApp Business account and add the number. Landlines are verified by a call afterwards.",
                  "سجّل الدخول بفيسبوك، واختر حساب واتساب للأعمال أو أنشئه، ثم أضف الرقم. يُتحقق من الهواتف الثابتة بمكالمة بعد ذلك.",
                )}
              </div>
              <EmbeddedSignupButton config={esConfig} tx={tx} canSeeConfig={canSeeConfig} disabled={atLimit} onConnected={onConnected} />
            </Section>
            <Section title={tx("Through Zernio", "عبر Zernio")}>{zernioPanel("whatsapp")}</Section>
            <Section title={tx("With an access token", "برمز وصول")} collapsible tx={tx}>
              <WhatsAppManualForm tx={tx} disabled={atLimit} onConnected={onConnected} />
            </Section>
          </>
        )}

        {(step === "facebook" || step === "instagram" || step === "tiktok") && (
          <>
            {back}
            {zernioPanel(step)}
          </>
        )}

        {step === "telegram" && (
          <>
            {back}
            <TelegramConnectForm tx={tx} onConnected={onConnected} />
          </>
        )}

        {step === "webchat" && (
          <>
            {back}
            <WebchatCreateForm tx={tx} onCreated={onConnected} />
          </>
        )}
      </div>
    </Modal>
  );
}

function Section({
  title,
  children,
  collapsible,
  tx,
}: {
  title: string;
  children: React.ReactNode;
  collapsible?: boolean;
  tx?: Tx;
}) {
  const [open, setOpen] = useState(!collapsible);
  return (
    <div style={{ display: "grid", gap: 8, padding: 12, borderRadius: 10, border: "1px solid var(--line-soft)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{title}</span>
        {collapsible && tx && (
          <button type="button" className="btn ghost sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? tx("Hide", "إخفاء") : tx("Show", "عرض")}
          </button>
        )}
      </div>
      {open && children}
    </div>
  );
}

/** Step one of a website chat: create it (POST /channels), then the hub opens its settings. */
function WebchatCreateForm({ tx, onCreated }: { tx: Tx; onCreated: (c: ChannelDto) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const displayName = name.trim();
    if (!displayName) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.post<ChannelDto>("/channels", { kind: "webchat", displayName }));
    } catch (e) {
      setError(channelErrorText(e, tx));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      style={{ display: "grid", gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <LabeledField
        label={tx("Name", "الاسم")}
        hint={tx(
          "Shown to visitors at the top of the chat, and in your inbox. Next you'll add your website and get the embed code.",
          "يظهر للزوار أعلى المحادثة وفي صندوق الرسائل. بعد ذلك ستضيف موقعك وتحصل على كود التضمين.",
        )}
      >
        <input dir="auto" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={tx("My shop", "متجري")} style={fieldInput} autoFocus />
      </LabeledField>
      <ErrorText>{error}</ErrorText>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
          {busy ? tx("Creating…", "جارٍ الإنشاء…") : tx("Create website chat", "إنشاء دردشة الموقع")}
        </button>
      </div>
    </form>
  );
}
