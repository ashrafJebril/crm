import { useCallback, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import { useAuth } from "@/auth/context";
import { usePermissions } from "@/auth/usePermissions";
import { Badge, statusKind } from "@/components/Badge";
import { useToast } from "@/components/Toast";
import { IconChev } from "@/icons";
import { makeTx, type Tx } from "@/lib/tx";
import type { Campaign, CampaignInsights, Lang } from "@/lib/types";
import { useChannelsList } from "@/screens/channels/channelUi";
import { useTweaks } from "@/tweaks/context";
import { campaignErrorText } from "./campaignErrors";
import { insightsPollMs, outcomeChips, type Outcome } from "./campaignDetailModel";
import { CampaignFunnel } from "./CampaignFunnel";
import { ExportDialog } from "./ExportDialog";
import { FailureReasonsCard } from "./FailureReasonsCard";
import { FollowUpDialog, type FollowUpMode } from "./FollowUpDialog";
import { ReadTimeCard } from "./ReadTimeCard";
import { RecipientsTable } from "./RecipientsTable";
import { ReplySummaryCard } from "./ReplySummaryCard";
import { SelectionBar } from "./SelectionBar";
import { Notice, formatWhen } from "./ui";

/**
 * When per-recipient tracking started, shown in the untracked notice. The
 * backend exposes no such date (reported as a contract gap); set it at release.
 */
export const PER_RECIPIENT_SINCE: string | null = null;

const campaignStatusLabel = (s: Campaign["status"], tx: Tx): string =>
  ({
    running: tx("Sending", "قيد الإرسال"),
    scheduled: tx("Scheduled", "مجدولة"),
    draft: tx("Draft", "مسودة"),
    completed: tx("Completed", "منتهية"),
    failed: tx("Failed", "فشلت"),
    cancelled: tx("Cancelled", "ملغاة"),
    paused: tx("Paused", "متوقفة"),
  })[s] ?? s;

type Dialog =
  | { kind: "export"; ticked: boolean }
  | { kind: "follow-up"; mode: FollowUpMode; groupId?: string }
  | null;

/** SP-12 campaign report (`#/campaigns?id=<id>`). */
export function CampaignDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTweaks();
  const lang: Lang = t.lang;
  const tx = makeTx(lang);
  const { toast } = useToast();
  const { can } = usePermissions();
  const { activeWorkspace } = useAuth();
  const tz = activeWorkspace?.timezone ?? null;

  const path = `/campaigns/${encodeURIComponent(id)}`;
  const pollRef = useRef<number | undefined>(undefined);
  // The poll interval comes from the last known campaign; both queries follow it,
  // so a campaign that finishes stops polling on the next tick. React Query
  // pauses the interval while the tab is hidden.
  const campaignQ = useFetch<Campaign | null>(path, { pollMs: pollRef.current });
  const c = campaignQ.data ?? null;
  const pollMs = insightsPollMs(c, Date.now()) ?? undefined;
  pollRef.current = pollMs;
  const insightsQ = useFetch<CampaignInsights>(c ? `${path}/insights` : null, { pollMs });
  const insights = insightsQ.data;

  const channelsQ = useChannelsList(can("channels.view"));
  const sender = useMemo(() => {
    const list = channelsQ.data ?? [];
    if (!c) return null;
    return c.senderChannelId
      ? (list.find((ch) => ch.id === c.senderChannelId) ?? null)
      : (list.find((ch) => ch.kind === "whatsapp" && ch.isDefault) ?? null);
  }, [channelsQ.data, c]);

  const [outcome, setOutcomeState] = useState<Outcome>("all");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [refreshing, setRefreshing] = useState(false);
  const tableRef = useRef<HTMLDivElement | null>(null);

  // A new outcome starts the table from its first page; ticks from the old filter are dropped.
  const setOutcome = useCallback((o: Outcome) => {
    setOutcomeState(o);
    setTicked(new Set());
  }, []);

  const refresh = async () => {
    setRefreshing(true);
    try {
      if (c?.zernioBroadcastId && can("campaigns.update")) await api.post(`${path}/refresh`);
      await Promise.all([campaignQ.refetch(), insightsQ.refetch()]);
      setReloadKey((k) => k + 1);
      toast(tx("Report updated", "تم تحديث التقرير"), "success");
    } catch (e) {
      toast(campaignErrorText(e, tx), "error");
    } finally {
      setRefreshing(false);
    }
  };

  const back = (
    <button className="btn ghost icon" onClick={onBack} aria-label={tx("Back to campaigns", "العودة للحملات")}>
      <IconChev w={14} className="flip-rtl" style={{ transform: "rotate(180deg)" }} />
    </button>
  );

  if (!c) {
    return (
      <div style={{ overflowY: "auto", flex: 1, padding: "20px 24px", display: "grid", gap: 14, alignContent: "start" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {back}
          <span style={{ fontSize: 14, color: campaignQ.error ? "var(--bad)" : "var(--ink-3)" }}>
            {campaignQ.loading
              ? tx("Loading report…", "جارٍ تحميل التقرير…")
              : campaignQ.error
                ? campaignQ.error === "Missing permission" || /403/.test(campaignQ.error)
                  ? tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك")
                  : tx("Couldn't load this campaign.", "تعذّر تحميل هذه الحملة.")
                : tx("This campaign no longer exists.", "هذه الحملة لم تعد موجودة.")}
          </span>
        </div>
      </div>
    );
  }

  const tracked = insights ? insights.tracked : c.recipientTracking === true;
  const neverSent = c.status === "draft";
  const funnel =
    insights?.funnel ?? {
      targeted: c.recipients,
      sent: c.sent + (c.failed ?? 0),
      delivered: c.delivered,
      read: c.read,
      replied: c.replied,
    };
  const total = insights?.total ?? 0;
  const chips = outcomeChips(insights?.counts ?? null, total, tx);
  const outcomeCount = chips.find((ch) => ch.id === outcome)?.count ?? 0;
  const syncedAt = tracked ? (insights?.recipientsSyncedAt ?? c.recipientsSyncedAt) : (insights?.statsSyncedAt ?? c.statsSyncedAt);
  const tickedIds = [...ticked];
  const campaignRef = { id: c.id, name: c.name };

  const canExport = can("contacts.manage") && can("campaigns.view");
  const perms = {
    canExport,
    canCreateGroup: can("audiences.create"),
    canAddToGroup: can("audiences.update"),
    canTag: can("contacts.update"),
  };

  const pickOutcome = (o: Outcome) => {
    setOutcome(o);
    tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div style={{ overflowY: "auto", flex: 1 }}>
      <header style={{ padding: "20px 24px 0", display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        {back}
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 dir="auto" style={{ margin: 0, fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {c.name}
          </h1>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "center", marginTop: 6, fontSize: 12, color: "var(--ink-3)" }}>
            <Badge kind={statusKind(c.status)} dot>
              {campaignStatusLabel(c.status, tx)}
            </Badge>
            <span>
              {tx("From", "من")}{" "}
              {sender ? (
                <>
                  <span dir="auto" style={{ color: "var(--ink-2)" }}>{sender.displayName}</span>
                  {sender.phoneNumber && (
                    <span className="mono" style={{ marginInlineStart: 6 }}>
                      <bdi dir="ltr">{sender.phoneNumber}</bdi>
                    </span>
                  )}
                </>
              ) : c.senderChannelId ? (
                tx("a WhatsApp number", "رقم واتساب")
              ) : (
                tx("the default WhatsApp number", "رقم واتساب الافتراضي")
              )}
            </span>
            {(c.launchedAt || c.scheduledAt) && (
              <span>
                {c.status === "scheduled" ? tx("Sends", "يُرسل") : tx("Sent", "أُرسلت")}{" "}
                {formatWhen(c.scheduledAt ?? c.launchedAt, lang, tz)}
              </span>
            )}
            {!neverSent && (
              <span>
                {tx("Last synced", "آخر مزامنة")} {syncedAt ? formatWhen(syncedAt, lang, tz) : tx("not yet", "لم تتم بعد")}
              </span>
            )}
          </div>
        </div>
        {!neverSent && (
          <button className="btn" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? tx("Refreshing…", "جارٍ التحديث…") : tx("Refresh", "تحديث")}
          </button>
        )}
      </header>

      <div style={{ padding: "16px 24px 24px", display: "grid", gap: 14 }}>
        {c.lastError && (
          <Notice tone="warn">
            <span dir="auto">{c.lastError}</span>
          </Notice>
        )}
        {insightsQ.error && (
          <div role="alert" style={{ fontSize: 12.5, color: "var(--bad)" }}>
            {tx("Couldn't load the report numbers.", "تعذّر تحميل أرقام التقرير.")}
          </div>
        )}

        {neverSent ? (
          <Notice>{tx("This campaign hasn't been sent yet, so there is no report.", "لم تُرسل هذه الحملة بعد، لذا لا يوجد تقرير.")}</Notice>
        ) : (
          <>
            {!tracked && (
              <Notice>
                {PER_RECIPIENT_SINCE
                  ? tx(
                      `Per-recipient details are available for campaigns sent after ${formatWhen(PER_RECIPIENT_SINCE, lang, tz)}. This campaign shows totals only.`,
                      `تفاصيل كل مستلم متاحة للحملات المرسلة بعد ${formatWhen(PER_RECIPIENT_SINCE, lang, tz)}. تعرض هذه الحملة الإجماليات فقط.`,
                    )
                  : tx(
                      "Per-recipient details are available for campaigns sent after per-recipient tracking was added. This campaign shows totals only.",
                      "تفاصيل كل مستلم متاحة للحملات المرسلة بعد إضافة تتبّع كل مستلم. تعرض هذه الحملة الإجماليات فقط.",
                    )}
              </Notice>
            )}

            <CampaignFunnel funnel={funnel} tx={tx} />

            {tracked && insights && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
                  <ReadTimeCard timing={insights.readTiming} tx={tx} />
                  <ReplySummaryCard replies={insights.replies} tx={tx} />
                </div>
                <FailureReasonsCard failures={insights.failures} unrecorded={insights.unrecorded} tx={tx} onPick={pickOutcome} />
              </>
            )}

            {tracked && (
              <div ref={tableRef} style={{ display: "grid", gap: 10, scrollMarginTop: 12 }}>
                <SelectionBar
                  tickedCount={ticked.size}
                  {...perms}
                  onExport={(t) => setDialog({ kind: "export", ticked: t })}
                  onFollowUp={(mode) => setDialog({ kind: "follow-up", mode })}
                  onClear={() => setTicked(new Set())}
                  tx={tx}
                />
                <RecipientsTable
                  campaignId={c.id}
                  outcome={outcome}
                  onOutcome={setOutcome}
                  chips={chips}
                  selected={ticked}
                  onSelected={setTicked}
                  reloadKey={reloadKey}
                  tx={tx}
                  lang={lang}
                  tz={tz}
                />
              </div>
            )}
          </>
        )}
      </div>

      {dialog?.kind === "export" && canExport && (
        <ExportDialog
          campaign={campaignRef}
          outcome={outcome}
          outcomeCount={outcomeCount}
          total={total}
          ticked={tickedIds}
          initialScope={dialog.ticked ? "ticked" : undefined}
          tx={tx}
          lang={lang}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "follow-up" && (
        <FollowUpDialog
          key={`${dialog.mode}:${dialog.groupId ?? ""}`}
          mode={dialog.mode}
          campaign={campaignRef}
          outcome={outcome}
          outcomeCount={outcomeCount}
          ticked={tickedIds}
          initialGroupId={dialog.groupId}
          tx={tx}
          lang={lang}
          onClose={() => setDialog(null)}
          onContinueInGroup={(groupId) => {
            if (perms.canAddToGroup) {
              setDialog({ kind: "follow-up", mode: "add-to-group", groupId });
              return;
            }
            toast(tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك"), "error");
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
