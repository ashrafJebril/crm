import { useState } from "react";
import { usePermissions } from "@/auth/usePermissions";
import { Badge } from "@/components/Badge";
import { PageHeader } from "@/components/PageHeader";
import { Skeleton } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";
import { IconPlus, IconStar } from "@/icons";
import { makeTx, type Tx } from "@/lib/tx";
import type { ChannelDto } from "@/lib/types";
import { TITLES } from "@/shell/nav";
import { useTweaks } from "@/tweaks/context";
import { useZernioConnect } from "@/screens/settings/ZernioCard";
import { AddChannelDialog } from "./AddChannelDialog";
import { ChannelDetail } from "./ChannelDetail";
import { channelErrorCopy, channelErrorText, statusReasonCopy } from "./channelErrors";
import { PROVIDER_LABEL, groupChannels, kindLabel, needsSync, statusBadge, verificationStage } from "./channelModel";
import { Banner, ErrorText, KindMark, useChannelsData, useHashParam } from "./channelUi";
import { NumberLimitNotice } from "./NumberLimitNotice";

/**
 * The channels hub (SP-19): every connected channel grouped by kind, with
 * status, default, WhatsApp usage, config warnings, a detail view (`?id=`)
 * and the Add channel flows. Refreshes on the `channels.updated` event.
 */
export default function ChannelsPage() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const { can, loading: permsLoading } = usePermissions();
  const canView = can("channels.view");
  const canCreate = can("channels.create");
  const canUpdate = can("channels.update");
  const canDelete = can("channels.delete");
  const { toast } = useToast();

  const { listQ, limitsQ, esQ, refresh } = useChannelsData(canView);
  const [openId, setOpenId] = useHashParam("id");
  const [adding, setAdding] = useState(false);
  const [showDisconnected, setShowDisconnected] = useState(false);
  const zernio = useZernioConnect(tx);

  if (!permsLoading && !canView) {
    return (
      <div style={{ padding: 24 }}>
        <PageHeader title={tx(TITLES.channels.en, TITLES.channels.ar)} />
        <div className="muted" style={{ padding: "0 24px", fontSize: 13 }}>
          {tx("You don't have permission to view channels.", "ليست لديك صلاحية لعرض القنوات.")}
        </div>
      </div>
    );
  }

  const list = listQ.data ?? [];
  const grouped = groupChannels(list);
  const firstLoad = (listQ.loading && !listQ.data) || permsLoading;
  const encryptionOff = canUpdate && limitsQ.data?.secretsEncryption === "off";
  const es = esQ.data;
  const esReason = es && !es.enabled ? channelErrorCopy(es.reason ?? "channels.embedded_signup_not_configured") : null;
  const opened = openId ? (list.find((c) => c.id === openId) ?? null) : null;
  const hasWhatsapp = list.some((c) => c.kind === "whatsapp" && c.status !== "disconnected");

  const onConnected = (c: ChannelDto) => {
    setAdding(false);
    refresh();
    const reason = statusReasonCopy(c.statusReason);
    if (c.status === "error" && reason) toast(tx(reason.en, reason.ar), "error");
    else if (c.status === "active") toast(tx(`${c.displayName} connected`, `تم ربط ${c.displayName}`), "success");
    setOpenId(c.id);
  };

  const syncAll = async () => {
    if (await zernio.sync()) {
      refresh();
      toast(tx("Synced with Zernio.", "تمت المزامنة مع Zernio."), "success");
    }
  };

  return (
    <div style={{ flex: 1, overflowY: "auto" }}>
      <PageHeader
        title={tx(TITLES.channels.en, TITLES.channels.ar)}
        subtitle={tx(
          "Every number, account, bot and website chat your inbox receives from.",
          "كل الأرقام والحسابات والبوتات ودردشات المواقع التي يستقبل منها صندوق الرسائل.",
        )}
        actions={
          <>
            {canUpdate && (
              <button type="button" className="btn" onClick={syncAll} disabled={zernio.busy === "sync"}>
                {zernio.busy === "sync" ? tx("Syncing…", "جارٍ المزامنة…") : tx("Sync Zernio", "مزامنة Zernio")}
              </button>
            )}
            {canCreate && (
              <button type="button" className="btn primary" onClick={() => setAdding(true)}>
                <IconPlus w={13} />
                {tx("Add channel", "إضافة قناة")}
              </button>
            )}
          </>
        }
      />

      <div style={{ padding: "4px 24px 32px", display: "grid", gap: 14, maxWidth: 980 }}>
        {encryptionOff && (
          <Banner tone="warn" title={tx("Channel secrets are not encrypted", "بيانات القنوات السرية غير مشفّرة")}>
            {tx(
              "TOKEN_ENC_KEY isn't set on the server, so bot tokens and access tokens are stored in plain text. In production new channels are refused until it is set.",
              "لم يُضبط TOKEN_ENC_KEY على الخادم، لذا تُحفظ رموز البوتات ورموز الوصول كنص عادي. في بيئة الإنتاج تُرفض القنوات الجديدة حتى يُضبط.",
            )}
          </Banner>
        )}
        {canUpdate && esReason && es && (
          <Banner tone="info" title={tx("Connect with Meta is unavailable", "الربط عبر Meta غير متاح")}>
            {tx(esReason.en, esReason.ar)}
            {es.missing && es.missing.length > 0 && (
              <div style={{ marginBlockStart: 4 }}>
                {tx("Missing server settings: ", "إعدادات الخادم الناقصة: ")}
                {es.missing.map((m, i) => (
                  <span key={m}>
                    {i > 0 && ", "}
                    <code className="mono" dir="ltr">{m}</code>
                  </span>
                ))}
              </div>
            )}
          </Banner>
        )}

        {(hasWhatsapp || limitsQ.data?.whatsapp.used) && limitsQ.data ? <NumberLimitNotice limits={limitsQ.data} tx={tx} /> : null}

        {zernio.error && <ErrorText>{zernio.error}</ErrorText>}
        {listQ.error && !listQ.data && <ErrorText>{channelErrorText(new Error(listQ.error), tx)}</ErrorText>}

        {firstLoad && (
          <div style={{ display: "grid", gap: 8 }} aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} style={{ display: "flex", gap: 12, alignItems: "center", padding: 12, borderRadius: 10, background: "var(--bg-1)", border: "1px solid var(--line-soft)" }}>
                <Skeleton w={32} h={32} radius={8} />
                <div style={{ flex: 1, display: "grid", gap: 6 }}>
                  <Skeleton h={11} w="35%" />
                  <Skeleton h={10} w="55%" />
                </div>
                <Skeleton h={18} w={70} radius={9} />
              </div>
            ))}
          </div>
        )}

        {!firstLoad && listQ.data && grouped.total === 0 && (
          <div style={{ textAlign: "center", padding: "48px 16px", border: "1px dashed var(--line)", borderRadius: 12, display: "grid", gap: 10, justifyItems: "center" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{tx("No channels yet", "لا توجد قنوات بعد")}</div>
            <div className="muted" style={{ fontSize: 13, maxWidth: 440, lineHeight: 1.55 }}>
              {tx(
                "Connect WhatsApp, Facebook, Instagram, TikTok or Telegram, or add a chat to your website. Messages land in your inbox.",
                "اربط واتساب أو فيسبوك أو إنستغرام أو تيك توك أو تيليجرام، أو أضف محادثة إلى موقعك. تصل الرسائل إلى صندوق الرسائل.",
              )}
            </div>
            {canCreate && (
              <button type="button" className="btn primary" onClick={() => setAdding(true)}>
                <IconPlus w={13} />
                {tx("Add your first channel", "أضف قناتك الأولى")}
              </button>
            )}
          </div>
        )}

        {grouped.groups.map((g) => {
          const k = kindLabel(g.kind);
          return (
            <section key={g.kind} style={{ display: "grid", gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 12, fontWeight: 600, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.06 }}>
                {tx(k.en, k.ar)} <span style={{ fontWeight: 400 }}>({g.channels.length})</span>
              </h2>
              {g.channels.map((c) => (
                <ChannelRow key={c.id} c={c} tx={tx} onOpen={() => setOpenId(c.id)} onSync={canUpdate ? syncAll : undefined} syncing={zernio.busy === "sync"} />
              ))}
            </section>
          );
        })}

        {grouped.disconnected.length > 0 && (
          <section style={{ display: "grid", gap: 8 }}>
            <button
              type="button"
              className="btn ghost sm"
              aria-expanded={showDisconnected}
              onClick={() => setShowDisconnected((s) => !s)}
              style={{ justifySelf: "start" }}
            >
              {showDisconnected ? tx("Hide", "إخفاء") : tx("Show", "عرض")} · {tx("Disconnected", "المفصولة")} ({grouped.disconnected.length})
            </button>
            {showDisconnected &&
              grouped.disconnected.map((c) => (
                <ChannelRow key={c.id} c={c} tx={tx} onOpen={() => setOpenId(c.id)} onSync={canUpdate ? syncAll : undefined} syncing={zernio.busy === "sync"} />
              ))}
          </section>
        )}
      </div>

      {adding && canCreate && (
        <AddChannelDialog
          tx={tx}
          limits={limitsQ.data}
          esConfig={es}
          canSeeConfig={canUpdate}
          onClose={() => setAdding(false)}
          onConnected={onConnected}
        />
      )}

      {openId && (
        <ChannelDetail
          channelId={openId}
          fromList={opened}
          tx={tx}
          lang={t.lang}
          perms={{ canUpdate, canDelete }}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function ChannelRow({
  c,
  tx,
  onOpen,
  onSync,
  syncing,
}: {
  c: ChannelDto;
  tx: Tx;
  onOpen: () => void;
  onSync?: () => void;
  syncing: boolean;
}) {
  const badge = statusBadge(c.status);
  const reason = statusReasonCopy(c.statusReason);
  const provider = PROVIDER_LABEL[c.provider];
  const stage = verificationStage(c.config);
  const stageText =
    stage === "needs_number"
      ? tx("Needs a number", "بحاجة إلى رقم")
      : stage === "awaiting_code"
        ? tx("Waiting for verification", "بانتظار التحقق")
        : stage === "needs_registration"
          ? tx("Not registered yet", "لم يُسجَّل بعد")
          : null;
  const reasonColor = c.status === "error" ? "var(--bad)" : c.status === "disconnected" || c.status === "active" ? "var(--ink-3)" : "var(--warn)";

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "center",
        padding: "10px 12px",
        borderRadius: 10,
        background: "var(--bg-1)",
        border: "1px solid var(--line-soft)",
        opacity: c.status === "disconnected" ? 0.75 : 1,
      }}
    >
      <KindMark kind={c.kind} />
      <button
        type="button"
        onClick={onOpen}
        style={{ flex: 1, minWidth: 0, textAlign: "start", background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer" }}
      >
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ fontWeight: 600, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} dir="auto">
            {c.displayName}
          </span>
          {c.isDefault && (
            <span title={tx("Default", "افتراضية")} aria-label={tx("Default", "افتراضية")} style={{ color: "var(--warn)", display: "inline-flex" }}>
              <IconStar w={13} />
            </span>
          )}
        </div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          {c.phoneNumber && (
            <>
              <bdi dir="ltr">{c.phoneNumber}</bdi>
              {" · "}
            </>
          )}
          {c.config?.botUsername && (
            <>
              <bdi dir="ltr">@{c.config.botUsername}</bdi>
              {" · "}
            </>
          )}
          {provider ? tx(provider.en, provider.ar) : c.provider}
          {stageText ? ` · ${stageText}` : ""}
        </div>
        {reason && (
          <div style={{ fontSize: 11.5, color: reasonColor, marginBlockStart: 2, lineHeight: 1.4 }}>{tx(reason.en, reason.ar)}</div>
        )}
      </button>
      {onSync && needsSync(c) && (
        <button type="button" className="btn sm" onClick={onSync} disabled={syncing}>
          {syncing ? tx("Syncing…", "جارٍ المزامنة…") : tx("Sync", "مزامنة")}
        </button>
      )}
      <Badge kind={badge.tone} dot>
        {tx(badge.en, badge.ar)}
      </Badge>
    </div>
  );
}
