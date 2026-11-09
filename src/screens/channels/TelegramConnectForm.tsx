import { useState } from "react";
import { api } from "@/api/client";
import type { Tx } from "@/lib/tx";
import type { ChannelDto } from "@/lib/types";
import { channelErrorText } from "./channelErrors";
import { ErrorText, LabeledField, fieldInput } from "./channelUi";

// Same shape the backend checks before calling Telegram (telegram.client BOT_TOKEN_RE).
const BOT_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,100}$/;

/**
 * Connect a Telegram bot: POST /channels/telegram {botToken, displayName?}.
 * The backend validates the token with getMe and registers the webhook. A
 * failure after the row exists comes back as a DTO with status "error"
 * (telegram_webhook_failed / telegram_save_failed), not as a throw, so the
 * caller opens the channel either way and its card shows the reason.
 */
export function TelegramConnectForm({ tx, onConnected }: { tx: Tx; onConnected: (c: ChannelDto) => void }) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = token.trim();
  const shapeOk = BOT_TOKEN_RE.test(trimmed);

  const submit = async () => {
    if (!shapeOk) return;
    setBusy(true);
    setError(null);
    try {
      const c = await api.post<ChannelDto>("/channels/telegram", {
        botToken: trimmed,
        ...(name.trim() ? { displayName: name.trim() } : {}),
      });
      setToken("");
      onConnected(c);
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
      <ol style={{ margin: 0, paddingInlineStart: 18, display: "grid", gap: 4, fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-2)" }}>
        <li>
          {tx("In Telegram, open ", "في تيليجرام، افتح ")}
          <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
            <bdi dir="ltr">@BotFather</bdi>
          </a>
          {tx(" and send /newbot (or /token for an existing bot).", " وأرسل ‎/newbot‎ (أو ‎/token‎ لبوت موجود).")}
        </li>
        <li>{tx("Copy the token it gives you and paste it below.", "انسخ الرمز الذي يعطيك إياه والصقه أدناه.")}</li>
      </ol>
      <LabeledField
        label={tx("Bot token", "رمز البوت")}
        hint={tx("Looks like 123456789:AA… It is stored encrypted and never shown again.", "يبدو مثل ‎123456789:AA…‎ يُحفظ مشفّرًا ولا يُعرض مرة أخرى.")}
        error={trimmed && !shapeOk ? tx("That doesn't look like a bot token.", "هذا لا يبدو رمز بوت.") : null}
      >
        <input
          dir="ltr"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="123456789:AAE…"
          style={{ ...fieldInput, fontFamily: "var(--font-mono)", fontSize: 12 }}
        />
      </LabeledField>
      <LabeledField
        label={tx("Name in the inbox (optional)", "الاسم في صندوق الرسائل (اختياري)")}
        hint={tx("Defaults to the bot's name.", "الافتراضي هو اسم البوت.")}
      >
        <input dir="auto" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} style={fieldInput} />
      </LabeledField>
      <ErrorText>{error}</ErrorText>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button type="submit" className="btn primary" disabled={busy || !shapeOk}>
          {busy ? tx("Connecting…", "جارٍ الربط…") : tx("Connect bot", "ربط البوت")}
        </button>
      </div>
    </form>
  );
}
