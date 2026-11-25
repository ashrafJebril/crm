import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { useFetch } from "@/api/useFetch";
import type { ChannelDto } from "@/lib/types";
import { fieldInput, fieldLabel } from "./channelUi";

type Tx = (en: string, ar: string) => string;

/** Instagram and Facebook are the only platforms where Meta allows a private
 *  reply to a comment — the rest can only reply publicly. */
export function supportsCommentAutoReply(channel: ChannelDto): boolean {
  return (
    channel.provider === "zernio" &&
    (channel.kind === "instagram" || channel.kind === "facebook") &&
    !!channel.externalId
  );
}

interface Rule {
  id: string;
  platform: string;
  accountId: string;
  keywords: string[];
  matchMode: string;
  platformPostId: string | null;
  dmMessage: string;
  commentReply: string | null;
  replyOncePerPerson: boolean;
  dmDelaySeconds: number;
  handoffToAgent: boolean;
  enabled: boolean;
  enabledAt: string | null;
  disabledAt: string | null;
}
interface RulesResponse {
  rules: Rule[];
  stats: Record<string, { dmsSent?: number; dmsFailed?: number; linkClicks?: number; uniqueContacts?: number }>;
  stale?: boolean;
}

const EMPTY = {
  keywords: [] as string[],
  matchMode: "contains",
  dmMessage: "",
  commentReply: "",
  replyOncePerPerson: true,
  dmDelaySeconds: 0,
  handoffToAgent: true,
};

/**
 * Comment auto-reply: a keyword comment gets a private DM, so the lead lands
 * in the inbox instead of being chased by hand in the comments.
 *
 * The switch is the important control here, and it is NOT a local flag — the
 * rule runs at Zernio and keeps running whether or not this app is up. So
 * switching on asks for confirmation (it starts messaging strangers) while
 * switching off never does (stopping should have no friction), and the card
 * always reports what the server says rather than what the user just clicked.
 */
export function CommentAutoReplyForm({
  channel,
  tx,
  canEdit,
}: {
  channel: ChannelDto;
  tx: Tx;
  canEdit: boolean;
}) {
  const accountId = channel.externalId ?? "";
  const q = useFetch<RulesResponse>("/integrations/zernio/comment-rules");
  const rule = useMemo(
    () => q.data?.rules.find((r) => r.accountId === accountId) ?? null,
    [q.data, accountId],
  );
  const stats = rule ? q.data?.stats?.[rule.id] : undefined;

  const [form, setForm] = useState(EMPTY);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOn, setConfirmOn] = useState(false);

  // Server state wins on every refetch — the rule can be changed elsewhere,
  // including in Zernio's own dashboard.
  useEffect(() => {
    if (!rule) {
      setForm(EMPTY);
      return;
    }
    setForm({
      keywords: rule.keywords,
      matchMode: rule.matchMode,
      dmMessage: rule.dmMessage,
      commentReply: rule.commentReply ?? "",
      replyOncePerPerson: rule.replyOncePerPerson,
      dmDelaySeconds: rule.dmDelaySeconds,
      handoffToAgent: rule.handoffToAgent,
    });
  }, [rule]);

  const dirty =
    !!rule &&
    (JSON.stringify(form.keywords) !== JSON.stringify(rule.keywords) ||
      form.matchMode !== rule.matchMode ||
      form.dmMessage !== rule.dmMessage ||
      (form.commentReply || "") !== (rule.commentReply ?? "") ||
      form.replyOncePerPerson !== rule.replyOncePerPerson ||
      form.dmDelaySeconds !== rule.dmDelaySeconds ||
      form.handoffToAgent !== rule.handoffToAgent);
  const canSave = form.keywords.length > 0 && form.dmMessage.trim().length > 0;
  const enabled = rule?.enabled ?? false;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await q.refetch();
    } catch (e) {
      setError(
        (e as { message?: string })?.message ??
          tx("Something went wrong. Try again.", "حدث خطأ. حاول مرة أخرى."),
      );
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", () =>
      api.post("/integrations/zernio/comment-rules", {
        accountId,
        keywords: form.keywords,
        matchMode: form.matchMode,
        dmMessage: form.dmMessage,
        commentReply: form.commentReply || null,
        replyOncePerPerson: form.replyOncePerPerson,
        dmDelaySeconds: form.dmDelaySeconds,
        handoffToAgent: form.handoffToAgent,
      }),
    );

  const addKeyword = () => {
    const k = keywordDraft.trim();
    if (!k || form.keywords.includes(k)) return;
    setForm((f) => ({ ...f, keywords: [...f.keywords, k] }));
    setKeywordDraft("");
  };

  const toggle = () => {
    if (!rule) return;
    if (enabled) {
      void run("toggle", () =>
        api.post(`/integrations/zernio/comment-rules/${rule.id}/disable`, {}),
      );
    } else {
      // Switching ON starts messaging real people, and Meta allows exactly one
      // DM per comment — so it is confirmed, unlike switching off.
      setConfirmOn(true);
    }
  };

  const confirmEnable = () => {
    if (!rule) return;
    setConfirmOn(false);
    void run("toggle", () => api.post(`/integrations/zernio/comment-rules/${rule.id}/enable`, {}));
  };

  return (
    <div
      style={{
        display: "grid",
        gap: 14,
        paddingBlockStart: 4,
        borderBlockStart: "1px solid var(--line-soft)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, paddingBlockStart: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontWeight: 600, fontSize: 13.5 }}>
            {tx("Comment auto-reply", "الرد التلقائي على التعليقات")}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginBlockStart: 2 }}>
            {tx(
              "Answer a keyword comment with a private DM, so the lead lands in your inbox.",
              "رد على التعليق الذي يحتوي كلمة مفتاحية برسالة خاصة، ليصل العميل إلى صندوق رسائلك.",
            )}
          </div>
        </div>
        {rule && (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={tx("Comment auto-reply", "الرد التلقائي على التعليقات")}
            disabled={!canEdit || busy === "toggle"}
            onClick={toggle}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: "none",
              border: "none",
              cursor: canEdit ? "pointer" : "default",
              padding: 0,
            }}
          >
            <span style={{ fontSize: 12, color: enabled ? "var(--ok)" : "var(--ink-3)" }}>
              {busy === "toggle"
                ? tx("Working…", "جارٍ التنفيذ…")
                : enabled
                  ? tx("Active", "مُفعّل")
                  : tx("Off", "متوقف")}
            </span>
            <span
              style={{
                width: 40,
                height: 23,
                borderRadius: 999,
                background: enabled ? "var(--accent)" : "var(--bg-3)",
                border: enabled ? "none" : "1px solid var(--line)",
                position: "relative",
                flex: "0 0 auto",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  insetBlock: 3,
                  insetInlineStart: enabled ? 20 : 3,
                  width: 17,
                  borderRadius: "50%",
                  background: enabled ? "var(--accent-ink)" : "var(--ink-4)",
                }}
              />
            </span>
          </button>
        )}
      </div>

      {q.data?.stale && (
        <Notice tone="warn">
          {tx(
            "Could not reach Zernio — this shows the last state we knew about.",
            "تعذّر الوصول إلى Zernio — هذه آخر حالة معروفة لدينا.",
          )}
        </Notice>
      )}
      {error && <Notice tone="bad">{error}</Notice>}

      {enabled && (
        <Notice tone="ok">
          {tx(
            "Running. New comments containing your keywords get a private DM.",
            "يعمل الآن. التعليقات الجديدة التي تحتوي كلماتك المفتاحية تتلقى رسالة خاصة.",
          )}
        </Notice>
      )}
      {rule && !enabled && rule.disabledAt && (
        <Notice tone="warn">
          {tx(
            "Paused. New comments are ignored — people already in your inbox are unaffected.",
            "متوقف مؤقتاً. التعليقات الجديدة يتم تجاهلها — ولا يتأثر من هم في صندوق رسائلك.",
          )}
        </Notice>
      )}

      <label style={{ display: "grid", gap: 6 }}>
        <span style={fieldLabel}>{tx("Trigger keywords", "الكلمات المفتاحية")}</span>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {form.keywords.map((k) => (
            <span
              key={k}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "var(--accent-soft)",
                border: "1px solid var(--accent-ring)",
                color: "var(--accent)",
                borderRadius: 999,
                padding: "2px 9px",
                fontSize: 12,
              }}
            >
              <span dir="auto">{k}</span>
              {canEdit && (
                <button
                  type="button"
                  aria-label={tx(`Remove ${k}`, `حذف ${k}`)}
                  onClick={() => setForm((f) => ({ ...f, keywords: f.keywords.filter((x) => x !== k) }))}
                  style={{ background: "none", border: "none", color: "var(--ink-3)", cursor: "pointer", padding: 0, fontSize: 11 }}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
          <input
            dir="auto"
            disabled={!canEdit}
            value={keywordDraft}
            onChange={(e) => setKeywordDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addKeyword();
              }
            }}
            onBlur={addKeyword}
            placeholder={tx("Type a word and press Enter…", "اكتب كلمة واضغط Enter…")}
            style={{ ...fieldInput, flex: 1, minWidth: 160 }}
          />
        </div>
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={fieldLabel}>{tx("Match", "المطابقة")}</span>
        <select
          disabled={!canEdit}
          value={form.matchMode}
          onChange={(e) => setForm((f) => ({ ...f, matchMode: e.target.value }))}
          style={fieldInput}
        >
          <option value="contains">{tx("Comment contains the word", "التعليق يحتوي الكلمة")}</option>
          <option value="word">{tx("Whole word only", "الكلمة كاملة فقط")}</option>
          <option value="exact">{tx("Comment is exactly the word", "التعليق هو الكلمة تماماً")}</option>
        </select>
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={fieldLabel}>{tx("Private message", "الرسالة الخاصة")}</span>
        <textarea
          dir="auto"
          disabled={!canEdit}
          rows={3}
          maxLength={900}
          value={form.dmMessage}
          onChange={(e) => setForm((f) => ({ ...f, dmMessage: e.target.value }))}
          placeholder={tx("The DM they get. End it with a question.", "الرسالة التي ستصلهم. أنهِها بسؤال.")}
          style={{ ...fieldInput, height: "auto", padding: "10px 12px", lineHeight: 1.5, resize: "vertical" }}
        />
        {/* The single most useful thing on this card: Meta grants ONE private
            reply per comment, so a message that invites no answer burns the
            lead permanently. Said where the mistake is made. */}
        <span style={{ fontSize: 11, color: "var(--warn)" }}>
          {tx(
            "⚠ End this with a question. Meta allows one DM per comment, and the conversation only continues if they answer — that answer is what creates the contact.",
            "⚠ أنهِ الرسالة بسؤال. ميتا تسمح برسالة واحدة لكل تعليق، والمحادثة تكمل فقط إذا ردّوا — وردّهم هو ما ينشئ جهة الاتصال.",
          )}
        </span>
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <span style={fieldLabel}>{tx("Public reply on the comment", "الرد العلني على التعليق")}</span>
        <input
          dir="auto"
          disabled={!canEdit}
          maxLength={200}
          value={form.commentReply}
          onChange={(e) => setForm((f) => ({ ...f, commentReply: e.target.value }))}
          placeholder={tx("Optional — e.g. “Sent you a DM 📩”", "اختياري — مثل: «بعتنالك عالخاص 📩»")}
          style={fieldInput}
        />
      </label>

      <Toggle
        label={tx("Reply once per person", "رد مرة واحدة لكل شخص")}
        hint={tx("Ignore the same person commenting again.", "تجاهل تعليقات الشخص نفسه المتكررة.")}
        checked={form.replyOncePerPerson}
        disabled={!canEdit}
        onChange={(v) => setForm((f) => ({ ...f, replyOncePerPerson: v }))}
      />
      <Toggle
        label={tx("Wait before sending", "انتظر قبل الإرسال")}
        hint={tx("An 8-second delay looks less robotic.", "تأخير 8 ثوانٍ يبدو أقل آلية.")}
        checked={form.dmDelaySeconds > 0}
        disabled={!canEdit}
        onChange={(v) => setForm((f) => ({ ...f, dmDelaySeconds: v ? 8 : 0 }))}
      />
      <Toggle
        label={tx("Hand over to the AI agent", "سلّم المحادثة للوكيل الذكي")}
        hint={tx("When they reply, let the agent answer in the inbox.", "عندما يردّون، دع الوكيل يجيب في صندوق الرسائل.")}
        checked={form.handoffToAgent}
        disabled={!canEdit}
        onChange={(v) => setForm((f) => ({ ...f, handoffToAgent: v }))}
      />

      {stats && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12 }} className="muted">
          <span>{tx("DMs sent", "رسائل مرسلة")}: {stats.dmsSent ?? 0}</span>
          <span>{tx("Failed", "فشلت")}: {stats.dmsFailed ?? 0}</span>
          <span>{tx("People reached", "أشخاص تم الوصول إليهم")}: {stats.uniqueContacts ?? 0}</span>
        </div>
      )}

      {canEdit && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn primary"
            disabled={!canSave || busy === "save" || (!!rule && !dirty)}
            onClick={() => void save()}
          >
            {busy === "save"
              ? tx("Saving…", "جارٍ الحفظ…")
              : rule
                ? tx("Save changes", "حفظ التغييرات")
                : tx("Save rule", "حفظ القاعدة")}
          </button>
          {!rule && (
            <span className="muted" style={{ fontSize: 11.5 }}>
              {tx("Nothing is sent until you switch it on.", "لا يتم إرسال شيء حتى تقوم بتفعيله.")}
            </span>
          )}
          {rule && enabled && dirty && (
            <span style={{ fontSize: 11.5, color: "var(--warn)" }}>
              {tx(
                "Saving restarts the rule — comments in those few seconds are not answered.",
                "الحفظ يعيد تشغيل القاعدة — التعليقات خلال تلك الثواني لن يُرد عليها.",
              )}
            </span>
          )}
        </div>
      )}

      {confirmOn && rule && (
        <ConfirmSwitchOn
          tx={tx}
          keywords={form.keywords}
          name={channel.displayName}
          onCancel={() => setConfirmOn(false)}
          onConfirm={confirmEnable}
        />
      )}
    </div>
  );
}

function Notice({ tone, children }: { tone: "ok" | "warn" | "bad"; children: React.ReactNode }) {
  const color = tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : "var(--bad)";
  return (
    <div
      style={{
        padding: "8px 12px",
        borderRadius: 8,
        fontSize: 12,
        color: "var(--ink-1)",
        // Tint from the tone, not from currentColor — currentColor here is the
        // ink above, which would make every tone the same grey.
        border: `1px solid color-mix(in oklab, ${color} 45%, transparent)`,
        background: `color-mix(in oklab, ${color} 10%, transparent)`,
      }}
    >
      <span style={{ color }}>●</span> {children}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 12, cursor: disabled ? "default" : "pointer" }}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 16, height: 16, accentColor: "var(--accent)", flex: "0 0 auto" }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 500, display: "block" }}>{label}</span>
        <span className="muted" style={{ fontSize: 11.5 }}>{hint}</span>
      </span>
    </label>
  );
}

/**
 * Switching on is the only action that reaches Zernio, so it is confirmed —
 * and the dialog states the rule people get wrong: Zernio answers only
 * comments posted while the automation is live, so everything already under
 * the post is lost.
 */
function ConfirmSwitchOn({
  tx,
  keywords,
  name,
  onCancel,
  onConfirm,
}: {
  tx: Tx;
  keywords: string[];
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        display: "grid",
        placeItems: "center",
        zIndex: 70,
        padding: 16,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          padding: 20,
          maxWidth: 430,
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBlockEnd: 8 }}>
          {tx("Switch on comment auto-reply?", "تفعيل الرد التلقائي على التعليقات؟")}
        </div>
        <div className="muted" style={{ fontSize: 13, marginBlockEnd: 8 }} dir="auto">
          {tx(
            `From now on, every new comment on ${name} containing ${keywords.join(", ")} gets a private DM.`,
            `من الآن، كل تعليق جديد على ${name} يحتوي ${keywords.join("، ")} ستصله رسالة خاصة.`,
          )}
        </div>
        <div style={{ fontSize: 13, marginBlockEnd: 16, color: "var(--warn)" }}>
          {tx(
            "Comments already under your posts will not be answered — only comments written from now on.",
            "التعليقات الموجودة مسبقاً على منشوراتك لن يُرد عليها — فقط التعليقات الجديدة من الآن.",
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn" onClick={onCancel}>
            {tx("Cancel", "إلغاء")}
          </button>
          <button type="button" className="btn primary" onClick={onConfirm}>
            {tx("Switch on", "تفعيل")}
          </button>
        </div>
      </div>
    </div>
  );
}
