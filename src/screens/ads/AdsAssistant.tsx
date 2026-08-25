import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTweaks } from "@/tweaks/context";
import { makeTx } from "@/lib/tx";
import { useAuth } from "@/auth/context";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/components/Toast";
import { MessageSkeleton } from "@/components/Skeleton";
import { ApiError, api } from "@/api/client";
import {
  approveAdsAction,
  postAdsChat,
  rejectAdsAction,
  useAdsChatSession,
  useAdsPrompts,
  useAdsWallet,
  type AdsChatMessageDto,
  type AdsLocale,
  type AdsPendingActionDto,
  type AdsPromptEntry,
  type GetAdsChatSessionResponse,
  type PostAdsChatRequest,
} from "@/api/ads";
import { IconSparkles } from "@/icons";
import { ActionCard } from "./ActionCard";
import { ChatBubble, TypingBubble } from "./ChatBubble";
import { PlatformBar } from "./PlatformBar";
import { PromptLibrary, type PromptCat } from "./PromptLibrary";
import { TipsPanel } from "./TipsPanel";
import "./ads-assistant.css";

// Always Latin digits and always three decimals — the wallet is Decimal(12,4)
// and a JOD fils is the third place, so trimming would misreport a balance.
const JOD = new Intl.NumberFormat("en-JO", {
  style: "currency",
  currency: "JOD",
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

const HHMM = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Session id storage key, namespaced per (workspace, user) so one login's
 *  stored thread can never surface under another on a shared device. */
const sessionKeyFor = (workspaceId: string, userId: string): string =>
  `aram.adsSession.${workspaceId}.${userId}.v1`;

function AdsAssistantImpl() {
  const { t } = useTweaks();
  const tx = makeTx(t.lang);
  const locale: AdsLocale = t.lang === "en" ? "en" : "ar";
  const { user, activeWorkspace } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Approve/reject are guarded server-side by WorkspaceRoles('owner','admin').
  // Mirroring the guard here turns a 403 into a disabled button with a reason,
  // instead of a click that fails; the toast below is still the safety net.
  const canManage = activeWorkspace?.role === "owner" || activeWorkspace?.role === "admin";

  const sessionKey =
    user?.id && activeWorkspace?.id ? sessionKeyFor(activeWorkspace.id, user.id) : null;

  const [thread, setThread] = useState<AdsChatMessageDto[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rehydrated, setRehydrated] = useState(false);
  // Transient (non-404) restore error → we KEEP the stored id and offer Retry.
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<Error | null>(null);
  // The optimistic user bubble's text, kept until the server echoes it back.
  const [pending, setPending] = useState<string | null>(null);
  // The exact body of the in-flight request, so Retry re-sends THAT.
  const [pendingBody, setPendingBody] = useState<Omit<PostAdsChatRequest, "sessionId" | "locale"> | null>(null);
  const [pendingActions, setPendingActions] = useState<AdsPendingActionDto[]>([]);
  const [lastBalance, setLastBalance] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [cat, setCat] = useState<PromptCat>("all");
  const [q, setQ] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const walletQ = useAdsWallet();
  const promptsQ = useAdsPrompts();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // ── Session bootstrap ────────────────────────────────────────────────────
  // Auth hydrates before this screen mounts (App gates on status), but the
  // workspace can still arrive a tick late — so read localStorage in an effect
  // once the (workspace, user) key exists, never in a useState initializer.
  // One-shot ref guard: runs at most once, never clobbers a live sessionId.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current || !sessionKey) return;
    bootstrapped.current = true;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(sessionKey);
    } catch {
      /* privacy mode — treat as "nothing stored" */
    }
    if (stored) setSessionId(stored);
    else setRehydrated(true); // nothing to restore → skip the loader and the GET
  }, [sessionKey]);

  // ── Rehydrate the adopted session ───────────────────────────────────────
  // A plain DB read (GET /ads/chat/sessions/:id) — ZERO paid model turns. Only a
  // genuine 404 (deleted / cross-workspace / not the caller's) is safe to
  // forget; everything else is transient, so we keep the id and offer Retry.
  const restorePath = sessionId && !rehydrated ? `/ads/chat/sessions/${sessionId}` : null;
  const restore = useAdsChatSession(sessionId && !rehydrated ? sessionId : null);
  useEffect(() => {
    if (rehydrated || !sessionId) return;
    // Act only on a settled fetch: refetch() flips loading true while React
    // Query still reports the STALE error, so gating on loading is what makes
    // Retry wait for the fresh result instead of snapping back to the error.
    if (restore.loading) return;
    if (restore.data) {
      setThread(restore.data.messages);
      setPendingActions(restore.data.pendingActions);
      setRehydrated(true);
      return;
    }
    if (!restore.error) return;
    // useFetch flattens the failure to a message string, so read the raw
    // ApiError back out of the shared query cache to see the STATUS. If it
    // isn't there, we fall through to "transient" — the safe direction, since a
    // kept id can always be retried but a wrongly cleared one loses the thread.
    const raw = restorePath ? qc.getQueryState([restorePath])?.error : null;
    if (raw instanceof ApiError && raw.status === 404) {
      if (sessionKey) {
        try {
          localStorage.removeItem(sessionKey);
        } catch {
          /* ignore */
        }
      }
      setSessionId(null);
      setRehydrated(true);
    } else {
      setRestoreFailed(true);
    }
  }, [restore.loading, restore.data, restore.error, restorePath, rehydrated, sessionId, sessionKey, qc]);
  const restoring = !!sessionId && !rehydrated && !restoreFailed;

  // ── Top-up redirect (…/#/ads?topup=success|cancel) ──────────────────────
  // The checkout gateway sends the customer back here. The hash router already
  // matches on the route part alone, so the query needs no router change — just
  // read it, tell them what happened, and strip it so a refresh can't re-fire.
  const topupHandled = useRef(false);
  useEffect(() => {
    if (topupHandled.current) return;
    const hash = window.location.hash;
    const qi = hash.indexOf("?");
    if (qi < 0) return;
    const topup = new URLSearchParams(hash.slice(qi + 1)).get("topup");
    if (topup !== "success" && topup !== "cancel") return;
    topupHandled.current = true;
    const tt = makeTx(t.lang);
    if (topup === "success") {
      toast(
        tt("Top-up received — your balance is up to date.", "تم استلام الشحن — رصيدك محدَّث الآن."),
        "success",
      );
    } else {
      toast(
        tt("Top-up cancelled — nothing was charged.", "تم إلغاء الشحن — لم يتم خصم أي مبلغ."),
        "info",
      );
    }
    // replaceState (not a hash assignment) → no extra history entry and no
    // hashchange, so the route stays exactly where it is.
    const { pathname, search } = window.location;
    window.history.replaceState(null, "", `${pathname}${search}${hash.slice(0, qi)}`);
  }, [toast, t.lang]);

  // Pin the thread to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread, pending, sending]);

  // ── Error branches ──────────────────────────────────────────────────────
  // A pre-flush failure carries a real HTTP status; a post-flush SSE failure
  // arrives as synthetic 502 + the real code — so every branch checks both.
  const apiErr = sendErr instanceof ApiError ? sendErr : null;
  const insufficient = apiErr?.status === 402 || apiErr?.code === "ADS_INSUFFICIENT_BALANCE";
  const promptLocked = apiErr?.code === "PROMPT_NOT_AVAILABLE";
  const serviceBusy = apiErr?.status === 503 || apiErr?.code === "ADS_SERVICE_BUSY";
  const blocked = sending || !!insufficient || restoring || restoreFailed;

  // ── Send ────────────────────────────────────────────────────────────────
  // Every chat request goes through dispatch, so `locale` is ALWAYS attached
  // and the body carries EXACTLY ONE of { message } | { promptId }.
  const dispatch = async (
    displayText: string,
    body: Omit<PostAdsChatRequest, "sessionId" | "locale">,
  ) => {
    if (sending || insufficient) return;
    setSending(true);
    setSendErr(null);
    setPending(displayText);
    setPendingBody(body);
    try {
      const data = await postAdsChat({ sessionId: sessionId ?? undefined, locale, ...body });
      setSessionId(data.sessionId);
      if (sessionKey) {
        try {
          localStorage.setItem(sessionKey, data.sessionId);
        } catch {
          /* privacy mode — the thread just won't survive a reload */
        }
      }
      setRehydrated(true);
      setThread((prev) => [...prev, ...data.messages]);
      setPendingActions(data.proposals); // the full open set for the session
      setLastBalance(data.balanceAfterJod);
      setPending(null);
      setPendingBody(null);
    } catch (e) {
      // Keep `pending` + `pendingBody` so the optimistic bubble stays visible
      // and Retry re-sends the identical body.
      setSendErr(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setSending(false);
    }
  };

  const sendText = (text?: string) => {
    const msg = (text ?? draft).trim();
    if (!msg) return;
    setDraft("");
    void dispatch(msg, { message: msg });
  };

  // The ▶ button is the only caller. Locked rows have no ▶ and this re-guards on
  // status — two layers — and the confirmed bubble shows the server-RESOLVED
  // text from data.messages, never this preview.
  const runPrompt = (entry: AdsPromptEntry) => {
    if (entry.status !== "active") return;
    void dispatch(locale === "en" ? entry.promptEn : entry.promptAr, { promptId: entry.id });
  };

  const retry = () => {
    if (pendingBody) void dispatch(pending ?? "", pendingBody);
  };

  // ── Approvals ───────────────────────────────────────────────────────────
  // After either call settles (success OR failure) re-GET the session so the
  // thread picks up the server's outcome note and the card leaves the open set
  // — including a 409/410 where it had already been acted on or expired.
  const refreshSession = async (sid: string) => {
    try {
      const data = await api.get<GetAdsChatSessionResponse>(`/ads/chat/sessions/${sid}`);
      setThread(data.messages);
      setPendingActions(data.pendingActions);
    } catch {
      /* transient — keep the current state rather than blanking the thread */
    }
  };

  const actOnProposal = async (
    actionId: string,
    call: (id: string) => Promise<unknown>,
  ) => {
    if (actionBusyId) return;
    setActionBusyId(actionId);
    try {
      await call(actionId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        toast(
          tx(
            "Only a workspace owner or admin can approve or reject ads actions.",
            "الموافقة على إجراءات الإعلانات أو رفضها متاح لمالك مساحة العمل أو المشرف فقط.",
          ),
          "error",
        );
      } else {
        toast(
          e instanceof Error && e.message
            ? e.message
            : tx("Something went wrong. Please try again.", "حدث خطأ ما. حاول مرة أخرى."),
          "error",
        );
      }
    } finally {
      setActionBusyId(null);
      if (sessionId) await refreshSession(sessionId);
    }
  };

  const copyPrompt = (entry: AdsPromptEntry) => {
    const text = locale === "en" ? entry.promptEn : entry.promptAr;
    // .catch as well as try/catch: a denied clipboard permission REJECTS rather
    // than throwing, and an unhandled rejection would surface as a console error.
    try {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    } catch {
      /* no clipboard API at all (insecure context) — the copied tick still fires */
    }
    setCopiedId(entry.id);
    window.setTimeout(() => setCopiedId((c) => (c === entry.id ? null : c)), 1400);
  };

  // ── Prompt filtering ────────────────────────────────────────────────────
  const allPrompts = promptsQ.data?.prompts ?? [];
  const tips = promptsQ.data?.tips ?? [];
  // "All" searches everything; a category searches within it. The count badge
  // reflects THIS set (active chip ∩ search), not the category total.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allPrompts.filter((p) => {
      if (cat !== "all" && p.category !== cat) return false;
      if (!needle) return true;
      const title = (locale === "en" ? p.titleEn : p.titleAr).toLowerCase();
      const desc = (locale === "en" ? p.descEn : p.descAr).toLowerCase();
      return title.includes(needle) || desc.includes(needle);
    });
  }, [allPrompts, cat, q, locale]);

  const balanceStr = lastBalance ?? walletQ.data?.wallet.balanceJod ?? null;
  const isEmpty = thread.length === 0 && !pending && !restoring && !restoreFailed;

  return (
    <div className="ads-scope">
      <PageHeader
        title={tx("Ads Assistant", "مساعد الإعلانات")}
        subtitle={tx(
          "Ask about your ad campaigns' performance and get instant analysis based on your real data.",
          "اسأل عن أداء حملاتك الإعلانية واحصل على تحليل فوري مبني على بياناتك الفعلية.",
        )}
        actions={
          balanceStr != null ? (
            <span className="ads-balance">
              <span>{tx("Balance", "الرصيد")}</span>
              <span className="val mono" dir="ltr">
                {JOD.format(Number(balanceStr))}
              </span>
            </span>
          ) : null
        }
      />

      <PlatformBar tx={tx} />

      {/* Two-column body: chat takes the remaining width, library column fixed. */}
      <div className="ads-body">
        <div className="ads-main">
          <div className="ads-thread" ref={scrollRef}>
            {restoring ? (
              <>
                <div
                  className="pulse"
                  style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "center", padding: "4px 0" }}
                >
                  {tx("Restoring your conversation…", "جاري استرجاع محادثتك…")}
                </div>
                <MessageSkeleton side="right" />
                <MessageSkeleton side="left" />
                <MessageSkeleton side="right" />
              </>
            ) : restoreFailed ? (
              <div className="ads-thread-empty">
                <div style={{ fontSize: 13, color: "var(--ink-3)" }}>
                  {tx(
                    "Couldn't restore your conversation — try again.",
                    "ما قدرنا نرجّع محادثتك — جرّب كمان مرة.",
                  )}
                </div>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setRestoreFailed(false);
                    // Reset first: it clears the cached error in the same tick,
                    // so the effect above can't re-process the STALE failure
                    // before the new request has flipped `loading` on and snap
                    // us straight back to this screen. refetch() then guarantees
                    // a request even if nothing else re-subscribes (React Query
                    // de-dupes if reset already started one).
                    if (restorePath) void qc.resetQueries({ queryKey: [restorePath], exact: true });
                    restore.refetch();
                  }}
                >
                  {tx("Retry", "إعادة المحاولة")}
                </button>
              </div>
            ) : isEmpty ? (
              <div className="ads-thread-empty">
                <span style={{ color: "var(--ink-4)", display: "flex", marginBottom: 6 }}>
                  <IconSparkles w={40} />
                </span>
                <div style={{ fontSize: 14, color: "var(--ink-2)", fontWeight: 500 }}>
                  {tx("Start a conversation with Salma", "ابدأ محادثة مع سلمى")}
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-4)" }}>
                  {tx(
                    "Try: “How did my campaigns perform in the last 30 days?” — you'll get analysis based on your real data.",
                    "اسأل مثلاً: «كيف أداء حملاتي آخر 30 يوم؟» وستحصل على تحليل مبني على بياناتك الفعلية.",
                  )}
                </div>
              </div>
            ) : (
              <>
                {thread.map((m) => (
                  <ChatBubble key={m.id} role={m.role} text={m.content} time={HHMM(m.createdAt)} />
                ))}
                {pendingActions.map((p) => (
                  <ActionCard
                    key={p.actionId}
                    proposal={p}
                    tx={tx}
                    busy={actionBusyId === p.actionId}
                    disabled={actionBusyId !== null}
                    canManage={canManage}
                    onApprove={() => void actOnProposal(p.actionId, approveAdsAction)}
                    onReject={() => void actOnProposal(p.actionId, rejectAdsAction)}
                  />
                ))}
                {pending && (
                  <ChatBubble
                    role="user"
                    text={pending}
                    time={HHMM(new Date().toISOString())}
                    muted
                  />
                )}
                {sending && <TypingBubble label={tx("Salma is typing…", "سلمى عم تكتبلك…")} />}
              </>
            )}
          </div>

          {/* Mutually exclusive, in order of how much they constrain the user. */}
          {insufficient ? (
            <div className="ads-lowbal" dir="auto">
              <div className="t">{tx("Paused — your balance is too low", "توقّف مؤقت — رصيدك لا يكفي")}</div>
              <div className="h">
                {tx(
                  "Your current balance isn't enough to start a new request.",
                  "رصيدك الحالي غير كافٍ لإكمال طلب جديد.",
                )}
              </div>
              <div className="s">
                {tx("Wallet top-up is coming soon.", "خاصية شحن الرصيد ستتوفّر قريباً.")}
              </div>
            </div>
          ) : promptLocked ? (
            <div className="ads-alert" dir="auto">
              <span>
                {tx(
                  "This prompt isn’t available yet — coming soon.",
                  "هذا السؤال غير متاح حالياً — بيتفعّل قريباً.",
                )}
              </span>
            </div>
          ) : serviceBusy ? (
            <div className="ads-alert" dir="auto">
              <span>
                {tx(
                  "The service is briefly busy — try again in a moment.",
                  "الخدمة مزدحمة مؤقتاً — جرّب بعد لحظات.",
                )}
              </span>
              <button type="button" className="btn sm" onClick={retry}>
                {tx("Retry", "إعادة المحاولة")}
              </button>
            </div>
          ) : sendErr ? (
            <div className="ads-alert" dir="auto">
              <span>
                {sendErr.message ||
                  tx("Something went wrong. Please try again.", "حدث خطأ ما. حاول مرة أخرى.")}
              </span>
              <button type="button" className="btn sm" onClick={retry}>
                {tx("Retry", "إعادة المحاولة")}
              </button>
            </div>
          ) : null}

          <div className="ads-composer">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (blocked) return;
                // Enter sends, Shift+Enter inserts a newline. The isComposing
                // guard keeps an IME candidate selection from sending early.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  sendText();
                }
              }}
              placeholder={tx("Type your question here…", "اكتب سؤالك هنا…")}
              rows={1}
              dir="auto"
              disabled={blocked}
            />
            <button
              type="button"
              className="btn primary"
              onClick={() => sendText()}
              disabled={!draft.trim() || blocked}
            >
              {tx("Send", "إرسال")}
            </button>
          </div>
        </div>

        {/* Side column — connection chip, then the library (fills), then tips. */}
        <div className="ads-side">
          <div className="ads-conn">
            <span className="live-dot" />
            <span>{tx("Connected to Meta account", "متصل بحساب ميتا")}</span>
          </div>

          <PromptLibrary
            tx={tx}
            locale={locale}
            cat={cat}
            onCat={setCat}
            q={q}
            onQ={setQ}
            filtered={filtered}
            loading={promptsQ.loading && !promptsQ.data}
            disabled={blocked}
            copiedId={copiedId}
            onCopy={copyPrompt}
            onRun={runPrompt}
          />

          <TipsPanel tips={tips} locale={locale} tx={tx} />
        </div>
      </div>
    </div>
  );
}

export default memo(AdsAssistantImpl);
