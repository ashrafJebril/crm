import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import { mediaKeyText } from "@/components/media/mediaErrors";
import type { Tx } from "@/lib/tx";
import { TICKET_ATTACHMENTS_MAX } from "./ticketFields";
import { ticketActionError } from "./boardQuery";

/**
 * SP-09 copy for the backend's ticket error keys (backend/src/tickets/ticket-errors.ts).
 * The key is the error's `message` (a ValidationPipe refusal sends it as
 * `message: [key]`, which ApiError joins); extras such as `limit` ride in `.body`.
 */

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => [en: string, ar: string];

const isObject = (v: unknown): v is Extra => typeof v === "object" && v !== null;

export const TICKET_ERROR_COPY: Record<string, CopyFn> = {
  "tickets.invalid_priority": () => ["Choose a priority from the list.", "اختر أولوية من القائمة."],
  "tickets.invalid_category": () => ["Choose a category from the list.", "اختر تصنيفًا من القائمة."],
  "tickets.attachments_full": (x) => {
    const n = typeof x.limit === "number" && x.limit > 0 ? x.limit : TICKET_ATTACHMENTS_MAX;
    return [
      `This ticket already has ${n} files, the most it can hold. Remove one first.`,
      `هذه التذكرة تحتوي على ${n} ملفًا، وهو الحد الأقصى. احذف ملفًا أولًا.`,
    ];
  },
  "tickets.no_conversation": () => [
    "This ticket has no linked conversation, so there are no customer files to add.",
    "هذه التذكرة غير مرتبطة بمحادثة، لذا لا توجد ملفات من العميل لإضافتها.",
  ],
  "tickets.attachment_not_found": () => [
    "That file is no longer on this ticket.",
    "هذا الملف لم يعد مرفقًا بهذه التذكرة.",
  ],
  "tickets.attachment_source_not_found": () => [
    "That file isn't from this ticket's conversation, or it was removed.",
    "هذا الملف ليس من محادثة هذه التذكرة، أو أنه حُذف.",
  ],
  "tickets.attachment_exists": () => ["That file is already on this ticket.", "هذا الملف مرفق بالتذكرة بالفعل."],
  "tickets.no_resolved_stage": () => [
    "This pipeline has no resolved stage. Add a won closing stage in the pipeline settings.",
    "لا توجد مرحلة حل في هذا المسار. أضف مرحلة إغلاق ناجحة من إعدادات المسار.",
  ],
  "tickets.already_closed": () => ["This ticket is already closed.", "هذه التذكرة مغلقة بالفعل."],
  "tickets.stage_changed": () => [
    "Someone moved this ticket while you were resolving it. Check its stage and try again.",
    "نقل شخص آخر هذه التذكرة أثناء حلّها. تحقق من مرحلتها ثم حاول مرة أخرى.",
  ],
  "Ticket not found": () => ["This ticket no longer exists.", "هذه التذكرة لم تعد موجودة."],
};

/** Copy for a ticket key with its extras, or null when the key is not a ticket key. */
export function ticketKeyText(key: string, extra: unknown, tx: Tx): string | null {
  const copy = TICKET_ERROR_COPY[key];
  if (!copy) return null;
  const [en, ar] = copy(isObject(extra) ? extra : {});
  return tx(en, ar);
}

/**
 * User-facing text for any error from the SP-09 ticket routes: a 403 is the
 * shared no-permission line; ticket keys, then the SP-13 media keys (staff
 * upload), then the older lead/reopen keys; else the fallback.
 */
export function ticketErrorText(err: unknown, tx: Tx, fallback?: string): string {
  if (err instanceof ApiError && err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const message = err instanceof Error ? err.message : "";
  const key = message.split(", ")[0] ?? "";
  const body = err instanceof ApiError ? err.body : undefined;
  const known = ticketKeyText(key, body, tx) ?? mediaKeyText(key, body, tx);
  if (known) return known;
  const legacy = message ? ticketActionError(tx, message) : message;
  if (legacy && legacy !== message) return legacy;
  return fallback ?? tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.");
}
