import { useState } from "react";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { ChannelDto } from "@/lib/types";
import { channelErrorText } from "./channelErrors";
import { Banner, ErrorText, LabeledField, fieldInput } from "./channelUi";

interface ManualResult {
  channel: ChannelDto;
  webhookSubscribed: boolean;
  discovered: {
    wabas: { id: string; name?: string; phones: { id: string; displayPhoneNumber?: string; verifiedName?: string }[] }[];
    picked: { wabaId: string; phoneNumberId: string };
  };
}

/**
 * Add a WhatsApp number with a Meta access token: POST /channels/whatsapp/manual
 * {accessToken, phoneNumberId?}. Without a number id the backend adds the
 * token's first number this workspace does not hold yet; `discovered` lists
 * the token's other numbers so one can be picked and added explicitly.
 */
export function WhatsAppManualForm({
  tx,
  disabled,
  onConnected,
}: {
  tx: Tx;
  disabled?: boolean;
  onConnected: (c: ChannelDto) => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ManualResult | null>(null);

  const submit = async (phoneNumberId?: string) => {
    const accessToken = token.trim();
    if (accessToken.length < 20) return;
    setBusy(phoneNumberId ?? "main");
    setError(null);
    try {
      const r = await api.post<ManualResult>("/channels/whatsapp/manual", {
        accessToken,
        ...(phoneNumberId ? { phoneNumberId } : {}),
      });
      setResult(r);
      onConnected(r.channel);
    } catch (e) {
      setError(channelErrorText(e, tx));
    } finally {
      setBusy(null);
    }
  };

  const others =
    result?.discovered.wabas.flatMap((w) =>
      w.phones.filter((p) => p.id !== result.discovered.picked.phoneNumberId).map((p) => ({ ...p, waba: w.name ?? w.id })),
    ) ?? [];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <ol style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 4, fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-2)" }}>
        <li>
          {tx("Open ", "افتح ")}
          <a href="https://business.facebook.com/wa/manage/home/" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
            {tx("Meta WhatsApp Manager", "إدارة واتساب في Meta")}
          </a>
          {tx(
            " and create a permanent System User token with whatsapp_business_messaging and whatsapp_business_management.",
            " وأنشئ رمز مستخدم نظام دائمًا بصلاحيتي whatsapp_business_messaging وwhatsapp_business_management.",
          )}
        </li>
        <li>{tx("Paste it below. We find the WhatsApp Business account and its numbers.", "الصقه أدناه، وسنجد حساب واتساب للأعمال وأرقامه.")}</li>
      </ol>
      <LabeledField label={tx("Access token", "رمز الوصول")} hint={tx("Starts with EAA… Stored encrypted.", "يبدأ بـ EAA… ويُحفظ مشفّرًا.")}>
        <textarea
          dir="ltr"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="EAAR…"
          style={{ ...fieldInput, height: "auto", padding: 8, fontFamily: "var(--font-mono)", fontSize: 11, resize: "vertical" }}
        />
      </LabeledField>
      <ErrorText>{error}</ErrorText>

      {result && (
        <Banner tone={result.webhookSubscribed ? "ok" : "warn"} title={tx("Number connected", "تم ربط الرقم")}>
          <bdi dir="ltr">{result.channel.phoneNumber ?? result.channel.displayName}</bdi>
          {!result.webhookSubscribed &&
            tx(
              " — Meta didn't subscribe the app to this account, so incoming messages may not arrive. Use Reconnect on the channel to retry.",
              " — لم تشترك Meta بالتطبيق في هذا الحساب، لذا قد لا تصل الرسائل الواردة. استخدم «إعادة الربط» على القناة للمحاولة مجددًا.",
            )}
        </Banner>
      )}

      {others.length > 0 && (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>{tx("Other numbers on this token", "أرقام أخرى على هذا الرمز")}</div>
          {others.map((p) => (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <span style={{ flex: 1 }}>
                <bdi dir="ltr">{p.displayPhoneNumber ?? p.id}</bdi>
                {p.verifiedName ? ` · ${p.verifiedName}` : ""}
              </span>
              <button type="button" className="btn sm" disabled={!!busy || disabled} onClick={() => submit(p.id)}>
                {busy === p.id ? tx("Adding…", "جارٍ الإضافة…") : tx("Add this number", "أضف هذا الرقم")}
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          className="btn primary"
          disabled={!!busy || disabled || token.trim().length < 20}
          onClick={() => submit()}
        >
          {busy === "main" ? tx("Connecting…", "جارٍ الربط…") : result ? tx("Add next number", "أضف الرقم التالي") : tx("Connect number", "ربط الرقم")}
        </button>
      </div>
    </div>
  );
}
