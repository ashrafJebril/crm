import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { mediaKeyText } from "@/components/media/mediaErrors";
import { GATE_AR, GATE_EN } from "@/components/whatsAppGateCopy";
import type { Tx } from "@/lib/tx";
import { isShortTitle } from "./failureCodes";
import { senderText } from "./senderModel";
import { varMapReasonText } from "./varMap";

/**
 * Localized copy for every SP-12 error key (backend campaign-errors.ts) and the
 * segments/tags messages the follow-up routes pass through. The backend puts
 * the key in `message` and extras (`limit`, `count`) next to it, which
 * `ApiError` exposes as `.message` and `.body`. Pure, so it is unit-tested for
 * completeness.
 */

type Extra = Record<string, unknown>;
/** Names the numbers in `template_missing_on_number` / `template_check_failed`. */
export interface ErrorContext {
  senders?: readonly { channelId: string; displayName?: string | null; phoneNumber?: string | null }[];
}
type CopyFn = (x: Extra, ctx: ErrorContext) => [en: string, ar: string];

const num = (v: unknown): string | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n.toLocaleString("en-US") : null;
};

export const CAMPAIGN_ERROR_COPY: Record<string, CopyFn> = {
  "campaigns.not_found": () => ["This campaign no longer exists.", "هذه الحملة لم تعد موجودة."],
  "campaigns.recipient_not_found": () => [
    "Some ticked recipients are no longer part of this campaign. Refresh and try again. Nothing was changed.",
    "بعض المستلمين المحددين لم يعودوا ضمن هذه الحملة. حدّث الصفحة وحاول مجددًا. لم يتغير شيء.",
  ],
  "campaigns.invalid_cursor": () => [
    "The list changed while loading. Refresh to start again.",
    "تغيّرت القائمة أثناء التحميل. حدّث الصفحة للبدء من جديد.",
  ],
  "campaigns.invalid_status": () => ["That outcome filter isn't valid.", "عامل تصفية النتيجة هذا غير صالح."],
  "campaigns.invalid_limit": () => ["That page size isn't valid.", "حجم الصفحة هذا غير صالح."],
  "campaigns.ids_too_many": (x) => {
    const limit = num(x.limit);
    return limit
      ? [
          `Too many rows ticked. Tick at most ${limit}, or use the whole outcome instead.`,
          `عدد الصفوف المحددة كبير جدًا. حدد ${limit} على الأكثر، أو استخدم النتيجة كاملة بدلًا من ذلك.`,
        ]
      : [
          "Too many rows ticked. Use the whole outcome instead.",
          "عدد الصفوف المحددة كبير جدًا. استخدم النتيجة كاملة بدلًا من ذلك.",
        ];
  },
  "campaigns.follow_up_target": () => [
    "Choose an outcome or tick some recipients first.",
    "اختر نتيجة أو حدد بعض المستلمين أولًا.",
  ],
  // `count` is only how far the scan got before it stopped (backend e44461f),
  // so the copy says "more than <limit>" and never quotes it.
  "campaigns.follow_up_too_large": (x) => {
    const limit = num(x.limit) ?? "10,000";
    return [
      `This outcome has more than ${limit} contacts, more than one action can handle. Tick fewer recipients instead. Nothing was changed.`,
      `تضم هذه النتيجة أكثر من ${limit} جهة اتصال، وهذا أكثر مما يمكن لإجراء واحد معالجته. حدد مستلمين أقل بدلًا من ذلك. لم يتغير شيء.`,
    ];
  },
  "campaigns.group_name_required": () => ["Give the group a name.", "أدخل اسمًا للمجموعة."],
  "Segment not found": () => [
    "That group no longer exists. Pick another one.",
    "هذه المجموعة لم تعد موجودة. اختر مجموعة أخرى.",
  ],
  "Members can only be managed on manual groups": () => [
    "Contacts can only be added to manual groups.",
    "يمكن إضافة جهات الاتصال إلى المجموعات اليدوية فقط.",
  ],
  "Tag not found": () => ["That tag no longer exists. Pick another one.", "هذا الوسم لم يعد موجودًا. اختر وسمًا آخر."],
  "Group name must be 1-120 characters": () => [
    "The group name must be 1 to 120 characters.",
    "يجب أن يكون اسم المجموعة من 1 إلى 120 حرفًا.",
  ],

  // ── SP-13 sending ──
  "campaigns.whatsapp_not_connected": () => [GATE_EN, GATE_AR],
  "campaigns.already_launched": () => [
    "This campaign was already launched. Refresh to see it.",
    "تم إطلاق هذه الحملة مسبقًا. حدّث الصفحة لرؤيتها.",
  ],
  "campaigns.sender_conflict": () => [
    "The sending numbers changed. Pick them again.",
    "تغيّرت أرقام الإرسال. اخترها مرة أخرى.",
  ],
  "campaigns.too_many_senders": (x) => {
    const limit = num(x.limit);
    return limit
      ? [`Your plan allows up to ${limit} numbers per campaign.`, `تسمح خطتك بـ ${limit} أرقام كحد أقصى لكل حملة.`]
      : ["Too many sending numbers for your plan.", "عدد أرقام الإرسال أكبر مما تسمح به خطتك."];
  },
  "campaigns.template_missing_on_number": (x, ctx) => {
    const n = numbers(x.channelIds, ctx);
    const many = plural(x.channelIds);
    return n
      ? [
          `The template isn't approved on ${n}. Remove ${many ? "those numbers" : "that number"} or get the template approved there.`,
          `القالب غير معتمد على ${n}. أزل ${many ? "هذه الأرقام" : "هذا الرقم"} أو اعتمد القالب هناك.`,
        ]
      : [
          "The template isn't approved on some of the chosen numbers. Remove them or get the template approved there.",
          "القالب غير معتمد على بعض الأرقام المختارة. أزلها أو اعتمد القالب عليها.",
        ];
  },
  "campaigns.template_check_failed": (x, ctx) => {
    const n = numbers(x.channelIds, ctx);
    return n
      ? [`Couldn't check the template on ${n}. Try again in a moment.`, `تعذّر التحقق من القالب على ${n}. حاول مجددًا بعد قليل.`]
      : [
          "Couldn't check the template on the chosen numbers. Try again in a moment.",
          "تعذّر التحقق من القالب على الأرقام المختارة. حاول مجددًا بعد قليل.",
        ];
  },
  "campaigns.template_not_approved": () => ["Choose a template Meta has approved.", "اختر قالبًا معتمدًا من ميتا."],
  "campaigns.template_unsupported": () => [
    "This template has header variables or a dynamic link button, which campaigns can't fill yet. Choose another template.",
    "يحتوي هذا القالب على متغيرات في الترويسة أو زر رابط متغير، ولا تستطيع الحملات تعبئتها بعد. اختر قالبًا آخر.",
  ],
  "campaigns.schedule_invalid": () => ["Pick a send time in the future.", "اختر وقت إرسال في المستقبل."],
  "campaigns.var_map_invalid": (x) => {
    const slot = typeof x.slot === "string" ? x.slot : null;
    const reason = typeof x.reason === "string" ? x.reason : "";
    return [varMapReasonText(reason, slot, (en) => en), varMapReasonText(reason, slot, (_en, ar) => ar)];
  },
  "campaigns.var_map_too_varied": (x) => {
    const parts = num(x.partitions);
    const limit = num(x.limit) ?? "25";
    const direct = num(x.directLimit) ?? "5,000";
    return [
      `The variables make ${parts ? `${parts} different messages` : "too many different messages"} (at most ${limit}), and the audience is over ${direct} people. Use fewer per-person fields, or a smaller audience.`,
      `تُنتج المتغيرات ${parts ? `${parts} رسالة مختلفة` : "رسائل مختلفة كثيرة"} (الحد ${limit})، والجمهور أكبر من ${direct} شخص. استخدم حقولًا شخصية أقل، أو جمهورًا أصغر.`,
    ];
  },
  // SP-13 final review (m3): a campaign header file sends each message on its own, up to the direct limit.
  "campaigns.header_direct_too_large": (x) => {
    const limit = num(x.limit) ?? "5,000";
    const reachable = num(x.reachable);
    return [
      `With its own header file, the campaign sends each message individually, which works for up to ${limit} recipients.${reachable ? ` This audience has ${reachable}.` : ""} Use the template's file or a smaller audience.`,
      `مع ملف ترويسة خاص، ترسل الحملة كل رسالة على حدة، وهذا يصلح لـ ${limit} مستلم كحد أقصى.${reachable ? ` هذا الجمهور فيه ${reachable}.` : ""} استخدم ملف القالب أو جمهورًا أصغر.`,
    ];
  },
  "campaigns.no_reachable_recipients": () => [
    "No one in the audience could receive it: no usable number, opted out, or a missing value without a fallback.",
    "لا أحد في الجمهور يمكنه استلامها: لا رقم صالح، أو ألغى الاشتراك، أو قيمة ناقصة بلا بديل.",
  ],
  "campaigns.header_media_schedule_too_far": (x) => {
    const days = num(x.days) ?? "6";
    return [
      `With a header file, a campaign can be scheduled at most ${days} days ahead.`,
      `مع ملف الترويسة، يمكن جدولة الحملة قبل ${days} أيام على الأكثر.`,
    ];
  },
  "campaigns.not_cancellable": () => [
    "This campaign isn't sending, so there is nothing to cancel.",
    "هذه الحملة لا تُرسل الآن، لذا لا يوجد ما يُلغى.",
  ],
  "campaigns.launch_failed": () => [
    "The campaign couldn't be sent. Create a new campaign to try again.",
    "تعذّر إرسال الحملة. أنشئ حملة جديدة للمحاولة مجددًا.",
  ],
  // SP-13 Task 2 fix round 1 (12a94da): DELETE refused while a broadcast may still send.
  "campaigns.has_live_broadcasts": () => [
    "This campaign may still be sending. Cancel it first.",
    "قد تكون هذه الحملة لا تزال قيد الإرسال. ألغِها أولاً.",
  ],
  "channels.sender_invalid": () => [
    "One of the chosen numbers can't send campaigns any more. Pick the numbers again.",
    "أحد الأرقام المختارة لم يعد يستطيع إرسال الحملات. اختر الأرقام مرة أخرى.",
  ],
};

const plural = (ids: unknown): boolean => Array.isArray(ids) && ids.length > 1;

/** The numbers named by `channelIds`, as "Name · +962…" with the number isolated; null when any is unknown. */
function numbers(ids: unknown, ctx: ErrorContext): string | null {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const list = ids.map((id) => {
    const s = ctx.senders?.find((x) => x.channelId === id);
    return s ? senderText(s) : "";
  });
  if (list.some((x) => !x)) return null;
  return list.join(", ");
}

const isObject = (v: unknown): v is Extra => typeof v === "object" && v !== null;

/** Copy for a campaign (or media / template-header) key with its extras; null when the key is unknown. */
export function campaignKeyText(key: string, extra: unknown, tx: Tx, ctx: ErrorContext = {}): string | null {
  const copy = CAMPAIGN_ERROR_COPY[key];
  if (copy) {
    const [en, ar] = copy(isObject(extra) ? extra : {}, ctx);
    return tx(en, ar);
  }
  return mediaKeyText(key, extra, tx);
}

/** User-facing text for any error from the campaign routes (SP-12 and SP-13). */
export function campaignErrorText(err: unknown, tx: Tx, ctx: ErrorContext = {}): string {
  if (err instanceof ApiError && err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const message = err instanceof Error ? err.message : "";
  // The client joins a validation array with ", "; its first key is enough.
  const key = message.split(", ")[0] ?? "";
  const body = err instanceof ApiError ? err.body : undefined;
  return (
    campaignKeyText(key, body, tx, ctx) ??
    campaignKeyText(message, body, tx, ctx) ??
    tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.")
  );
}

/**
 * A failed cancel (SP-13 12a94da): when a partition can't be stopped the
 * backend passes Zernio's error through and the status doesn't change. A
 * keyed error is worded; a short provider text is shown after a bilingual
 * lead so the user knows to retry; anything else reads as the generic copy.
 */
export function cancelErrorText(err: unknown, tx: Tx): string {
  if (err instanceof ApiError && err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const message = err instanceof Error ? err.message : "";
  const keyed = campaignKeyText(message.split(", ")[0] ?? "", err instanceof ApiError ? err.body : undefined, tx);
  if (keyed) return keyed;
  const lead = tx("Couldn't cancel every part of the campaign. Try again.", "تعذّر إلغاء كل أجزاء الحملة. حاول مجددًا.");
  return isShortTitle(message) && !/^HTTP \d+$/.test(message) ? `${lead} (${message.trim()})` : lead;
}

/**
 * A campaign's stored `lastError`: a launch-failure key (SP-13) is worded;
 * anything else (an older provider message) is shown as stored.
 */
export function lastErrorText(lastError: string | null | undefined, tx: Tx): string | null {
  const v = lastError?.trim();
  if (!v) return null;
  return campaignKeyText(v, {}, tx) ?? v;
}

/**
 * A create-group that failed after the group was made returns its usual error
 * key with `{groupId, added}` in the body (backend e44461f). The group exists,
 * so the page offers add-to-group for it instead of a plain error.
 */
export function partialGroup(err: unknown): { groupId: string; added: number } | null {
  if (!(err instanceof ApiError) || !isObject(err.body)) return null;
  const { groupId, added } = err.body;
  if (typeof groupId !== "string" || !groupId) return null;
  return { groupId, added: typeof added === "number" && Number.isFinite(added) ? added : 0 };
}

export function partialGroupText(p: { added: number }, tx: Tx): string {
  const n = p.added.toLocaleString("en-US");
  return tx(
    `Group created with ${n} contacts — use Add to group to finish`,
    `أُنشئت المجموعة وفيها ${n} جهة اتصال — استخدم «إضافة إلى مجموعة» لإكمال الباقي`,
  );
}
