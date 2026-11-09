import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";

/**
 * Localized copy for every SP-12 error key (backend campaign-errors.ts) and the
 * segments/tags messages the follow-up routes pass through. The backend puts
 * the key in `message` and extras (`limit`, `count`) next to it, which
 * `ApiError` exposes as `.message` and `.body`. Pure, so it is unit-tested for
 * completeness.
 */

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => [en: string, ar: string];

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
};

const isObject = (v: unknown): v is Extra => typeof v === "object" && v !== null;

/** User-facing text for any error from the SP-12 routes. */
export function campaignErrorText(err: unknown, tx: Tx): string {
  if (err instanceof ApiError && err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const message = err instanceof Error ? err.message : "";
  // The client joins a validation array with ", "; its first key is enough.
  const key = message.split(", ")[0] ?? "";
  const copy = CAMPAIGN_ERROR_COPY[key] ?? CAMPAIGN_ERROR_COPY[message];
  if (copy) {
    const body = err instanceof ApiError && isObject(err.body) ? err.body : {};
    const [en, ar] = copy(body);
    return tx(en, ar);
  }
  return tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.");
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
