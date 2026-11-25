import { useEffect, useState } from "react";
import { api, ApiError } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { Badge } from "@/components/Badge";
import { Modal } from "@/components/Modal";
import { IconStar, IconX } from "@/icons";
import type { Tx } from "@/lib/tx";
import type { ChannelDto, Lang } from "@/lib/types";
import { channelErrorText, statusReasonCopy } from "./channelErrors";
import {
  PROVIDER_LABEL,
  canMakeDefault,
  canReconnect,
  disconnectConfirmBody,
  kindLabel,
  needsSync,
  statusBadge,
  verificationStage,
} from "./channelModel";
import { Banner, ConfirmDialog, ErrorText, KindMark, fieldInput, fieldLabel } from "./channelUi";
import { ChatPageLink } from "./ChatPageLink";
import { LandlineVerificationCard } from "./LandlineVerificationCard";
import { WebchatSettingsForm } from "./WebchatSettingsForm";
import { WidgetSnippetDialog } from "./WidgetSnippetDialog";
import { NumberHealthSection } from "./health/NumberHealthSection";
import { hasNumberHealth } from "./health/healthModel";
import { useZernioConnect } from "@/screens/settings/ZernioCard";

interface Perms {
  canUpdate: boolean;
  canDelete: boolean;
}

/** One channel: status, rename, default, reconnect/sync, disconnect, and its kind's settings. */
export function ChannelDetail({
  channelId,
  fromList,
  tx,
  lang,
  perms,
  onClose,
  onChanged,
}: {
  channelId: string;
  /** The row from the list, when present (avoids a second fetch). */
  fromList: ChannelDto | null;
  tx: Tx;
  lang: Lang;
  perms: Perms;
  onClose: () => void;
  onChanged: () => void;
}) {
  // A deep link to a channel not in the list (or a stale list) reads it directly.
  const oneQ = useFetch<ChannelDto>(fromList ? null : `/channels/${encodeURIComponent(channelId)}`);
  // The last server answer of an action here, until the list refetches.
  const [local, setLocal] = useState<ChannelDto | null>(null);
  useEffect(() => {
    setLocal(null);
  }, [channelId, fromList]);
  const channel = (local?.id === channelId ? local : null) ?? fromList ?? oneQ.data;

  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [snippetOpen, setSnippetOpen] = useState(false);
  const zernio = useZernioConnect(tx);

  useEffect(() => {
    if (channel) setName(channel.displayName);
  }, [channel?.id, channel?.displayName]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = channel?.displayName ?? tx("Channel", "القناة");

  if (!channel) {
    return (
      <Modal onClose={onClose} label={title} width={620}>
        {oneQ.error ? (
          <div style={{ display: "grid", gap: 12 }}>
            <ErrorText>{channelErrorText(new Error(oneQ.error), tx)}</ErrorText>
            <button type="button" className="btn" style={{ justifySelf: "end" }} onClick={onClose}>
              {tx("Close", "إغلاق")}
            </button>
          </div>
        ) : (
          <div className="muted pulse" style={{ fontSize: 12 }}>{tx("Loading…", "جارٍ التحميل…")}</div>
        )}
      </Modal>
    );
  }

  const badge = statusBadge(channel.status);
  const reason = statusReasonCopy(channel.statusReason);
  const k = kindLabel(channel.kind);
  const provider = PROVIDER_LABEL[channel.provider];
  const disconnected = channel.status === "disconnected";
  const stage = verificationStage(channel.config);

  const act = async (key: string, fn: () => Promise<ChannelDto | unknown>, done?: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "id" in (r as object) && (r as ChannelDto).id === channel.id) setLocal(r as ChannelDto);
      if (done) setNotice(done);
      onChanged();
      return true;
    } catch (e) {
      setError(channelErrorText(e, tx));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const path = `/channels/${encodeURIComponent(channel.id)}`;
  const rename = () =>
    act("rename", () => api.patch<ChannelDto>(path, { displayName: name.trim() }), tx("Name saved.", "تم حفظ الاسم."));
  const makeDefault = () =>
    act("default", () => api.patch<ChannelDto>(path, { isDefault: true }), tx("This is now the default.", "أصبحت هذه القناة الافتراضية."));
  // Every provider with a hook goes through POST /channels/:id/reconnect.
  // Zernio resyncs and revives the row while its account still works; only
  // when Zernio needs a fresh sign-in does it fall back to the OAuth link,
  // which names this channel (exempt from the number limit; the redirect
  // capture reconnects it after the sync).
  const reconnect = async () => {
    setBusy("reconnect");
    setError(null);
    setNotice(null);
    try {
      const r = await api.post<ChannelDto>(`${path}/reconnect`);
      if (r && r.id === channel.id) setLocal(r);
      setNotice(tx("Reconnected.", "تمت إعادة الربط."));
      onChanged();
    } catch (e) {
      if (channel.provider === "zernio" && e instanceof ApiError && e.message === "channels.zernio_reauth_required") {
        setNotice(tx("Zernio needs a fresh sign-in for this account. Opening Zernio…", "يطلب Zernio تسجيل دخول جديدًا لهذا الحساب. جارٍ فتح Zernio…"));
        await zernio.start(channel.kind, { reconnectChannelId: channel.id });
        return;
      }
      setError(channelErrorText(e, tx));
    } finally {
      setBusy(null);
    }
  };
  const sync = async () => {
    setNotice(null);
    if (await zernio.sync()) {
      onChanged();
      setNotice(tx("Synced with Zernio.", "تمت المزامنة مع Zernio."));
    }
  };
  const disconnect = async () => {
    const ok = await act("disconnect", () => api.delete<ChannelDto>(path), tx("Disconnected. History is kept.", "تم الفصل. السجل محفوظ."));
    if (ok) setConfirm(false);
  };

  const nameDirty = name.trim() && name.trim() !== channel.displayName;
  const anyError = error ?? zernio.error;

  return (
    <Modal onClose={onClose} label={title} width={640}>
      <div style={{ display: "grid", gap: 16 }}>
        {/* Header */}
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <KindMark kind={channel.kind} size={40} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 16, fontWeight: 600 }} dir="auto">{channel.displayName}</span>
              {channel.isDefault && (
                <span title={tx("Default", "افتراضية")} style={{ color: "var(--warn)", display: "inline-flex", gap: 3, alignItems: "center", fontSize: 11.5 }}>
                  <IconStar w={13} />
                  {tx("Default", "افتراضية")}
                </span>
              )}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {tx(k.en, k.ar)}
              {provider ? ` · ${tx(provider.en, provider.ar)}` : channel.provider ? ` · ${channel.provider}` : ""}
              {channel.phoneNumber && (
                <>
                  {" · "}
                  <bdi dir="ltr">{channel.phoneNumber}</bdi>
                </>
              )}
              {channel.config?.botUsername && (
                <>
                  {" · "}
                  <a href={`https://t.me/${encodeURIComponent(channel.config.botUsername)}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                    <bdi dir="ltr">@{channel.config.botUsername}</bdi>
                  </a>
                </>
              )}
            </div>
          </div>
          <Badge kind={badge.tone} dot>
            {tx(badge.en, badge.ar)}
          </Badge>
          <button type="button" className="btn ghost icon sm" aria-label={tx("Close", "إغلاق")} onClick={onClose}>
            <IconX w={14} />
          </button>
        </div>

        {reason && (
          <Banner tone={channel.status === "error" ? "bad" : channel.status === "active" || disconnected ? "info" : "warn"}>
            {tx(reason.en, reason.ar)}
          </Banner>
        )}

        {/* Landline verification (pending Meta numbers) */}
        {stage && channel.provider === "meta" && (
          <LandlineVerificationCard
            channel={channel}
            tx={tx}
            lang={lang}
            canEdit={perms.canUpdate}
            onUpdated={(c) => {
              setLocal(c);
              onChanged();
            }}
          />
        )}

        {/* Actions */}
        {(perms.canUpdate || perms.canDelete) && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {perms.canUpdate && needsSync(channel) && (
              <button type="button" className="btn" onClick={sync} disabled={!!busy || zernio.busy === "sync"}>
                {zernio.busy === "sync" ? tx("Syncing…", "جارٍ المزامنة…") : tx("Sync", "مزامنة")}
              </button>
            )}
            {perms.canUpdate && canReconnect(channel) && (
              <button type="button" className="btn primary" onClick={reconnect} disabled={!!busy || !!zernio.busy}>
                {busy === "reconnect" || zernio.busy === channel.kind ? tx("Reconnecting…", "جارٍ إعادة الربط…") : tx("Reconnect", "إعادة الربط")}
              </button>
            )}
            {perms.canUpdate && canMakeDefault(channel) && (
              <button type="button" className="btn" onClick={makeDefault} disabled={!!busy}>
                <IconStar w={12} />
                {busy === "default" ? tx("Saving…", "جارٍ الحفظ…") : tx("Make default", "اجعلها الافتراضية")}
              </button>
            )}
            {perms.canDelete && !disconnected && (
              <button type="button" className="btn danger" style={{ marginInlineStart: "auto" }} onClick={() => setConfirm(true)} disabled={!!busy}>
                {stage ? tx("Remove pending number", "إزالة الرقم المعلّق") : tx("Disconnect", "فصل")}
              </button>
            )}
          </div>
        )}

        <ErrorText>{anyError}</ErrorText>
        {notice && <div role="status" style={{ fontSize: 12, color: "var(--ok)" }}>{notice}</div>}

        {/* Rename */}
        {perms.canUpdate && (
          <form
            style={{ display: "grid", gap: 5 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (nameDirty) void rename();
            }}
          >
            <span style={fieldLabel}>{tx("Name in the inbox", "الاسم في صندوق الرسائل")}</span>
            <div style={{ display: "flex", gap: 8 }}>
              <input dir="auto" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} style={fieldInput} />
              <button type="submit" className="btn" disabled={!nameDirty || !!busy}>
                {busy === "rename" ? tx("Saving…", "جارٍ الحفظ…") : tx("Rename", "إعادة التسمية")}
              </button>
            </div>
          </form>
        )}

        {/* Website chat */}
        {channel.kind === "webchat" && !disconnected && (
          <div style={{ display: "grid", gap: 14, paddingBlockStart: 4, borderBlockStart: "1px solid var(--line-soft)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBlockStart: 12 }}>
              <span style={{ fontWeight: 600, fontSize: 13.5, flex: 1 }}>{tx("Website chat", "دردشة الموقع")}</span>
              <button type="button" className="btn primary sm" onClick={() => setSnippetOpen(true)}>
                {tx("Get embed code", "احصل على كود التضمين")}
              </button>
            </div>
            <ChatPageLink channelId={channel.id} tx={tx} />
            <WebchatSettingsForm
              channel={channel}
              tx={tx}
              canEdit={perms.canUpdate}
              onSaved={(c) => {
                setLocal(c);
                onChanged();
              }}
            />
          </div>
        )}

        {/* SP-14 number health (WhatsApp on Zernio or Meta) */}
        {hasNumberHealth(channel) && !disconnected && (
          <NumberHealthSection
            channel={channel}
            tx={tx}
            lang={lang}
            canUpdate={perms.canUpdate}
            onUpdated={(c) => {
              setLocal(c);
              onChanged();
            }}
          />
        )}

        {channel.provider === "meta" && channel.kind === "whatsapp" && perms.canUpdate && !stage && <MetaWebhookInfo tx={tx} />}

        <div className="muted" style={{ fontSize: 11.5, display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span>
            {tx("Connected", "تاريخ الربط")}: {new Date(channel.createdAt).toLocaleDateString(lang === "ar" ? "ar" : "en")}
          </span>
          {channel.lastInboundAt && (
            <span>
              {tx("Last message in", "آخر رسالة واردة")}: {new Date(channel.lastInboundAt).toLocaleString(lang === "ar" ? "ar" : "en")}
            </span>
          )}
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          tx={tx}
          danger
          title={stage ? tx("Remove this pending number?", "إزالة هذا الرقم المعلّق؟") : tx(`Disconnect ${channel.displayName}?`, `فصل ${channel.displayName}؟`)}
          body={
            stage
              ? tx(
                  "The number stops waiting for verification and no longer counts toward your WhatsApp limit. You can add it again later.",
                  "يتوقف الرقم عن انتظار التحقق ولا يُحتسب ضمن حد أرقام واتساب. يمكنك إضافته مجددًا لاحقًا.",
                )
              : disconnectConfirmBody(channel, tx)
          }
          confirmLabel={stage ? tx("Remove", "إزالة") : tx("Disconnect", "فصل")}
          busy={busy === "disconnect"}
          error={error}
          onConfirm={disconnect}
          onClose={() => setConfirm(false)}
        />
      )}
      {snippetOpen && <WidgetSnippetDialog channel={channel} tx={tx} onClose={() => setSnippetOpen(false)} />}
    </Modal>
  );
}

interface WaStatus {
  connected: boolean;
  verifyToken?: string;
}

/**
 * Meta Cloud API numbers that use the workspace's own Meta app need its webhook
 * pointed at us. The verify token was shown on the old Settings card; it lives
 * here now (GET /integrations/whatsapp/status returns it to channels.update only).
 */
function MetaWebhookInfo({ tx }: { tx: Tx }) {
  const q = useFetch<WaStatus>("/integrations/whatsapp/status");
  if (!q.data?.connected || !q.data.verifyToken) return null;
  return (
    <details style={{ fontSize: 12 }}>
      <summary style={{ cursor: "pointer", color: "var(--ink-2)" }}>{tx("Webhook setup (your own Meta app)", "إعداد Webhook (تطبيق Meta الخاص بك)")}</summary>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 10px", marginBlockStart: 8 }}>
        <span className="muted">{tx("Callback URL", "عنوان الـ Callback")}</span>
        <code className="mono" dir="ltr" style={{ overflowWrap: "anywhere" }}>{"<your-public-url>/api/webhooks/whatsapp"}</code>
        <span className="muted">{tx("Verify token", "رمز التحقق")}</span>
        <code className="mono" dir="ltr" style={{ overflowWrap: "anywhere" }}>{q.data.verifyToken}</code>
        <span className="muted">{tx("Fields", "الحقول")}</span>
        <code className="mono" dir="ltr">messages</code>
      </div>
    </details>
  );
}
