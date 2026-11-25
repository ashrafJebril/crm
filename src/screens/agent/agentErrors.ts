import { ApiError } from "@/api/client";
import { NO_PERMISSION_AR, NO_PERMISSION_EN } from "@/auth/usePermissions";
import type { Tx } from "@/lib/tx";
import { dayName } from "@/screens/calendar/schedule";
import type { Weekday } from "@/screens/calendar/bookingTime";
import { scheduleReasonText } from "@/screens/calendar/bookingErrors";
import { BUSINESS_NAME_MAX, SANDBOX_MESSAGE_MAX } from "./agentConstants";

/**
 * SP-20 copy for the backend's agent and onboarding error keys
 * (backend/src/agent/agent-errors.ts, AGENT_ERROR_STATUS) and the signup
 * limiter's key (backend/src/auth/auth.controller.ts). The key is the
 * error's `message`; extras ride in the body. agentErrors.test.ts pins the
 * key list to the backend files.
 */

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra, lang: "en" | "ar") => [en: string, ar: string];

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const n = (v: number) => v.toLocaleString("en-US");
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const minutes = (s: number) => Math.max(1, Math.ceil(s / 60));

export const AGENT_ERROR_COPY: Record<string, CopyFn> = {
  "agent.name_required": () => ["Give your agent a name in English or Arabic.", "أعطِ وكيلك اسمًا بالإنجليزية أو العربية."],
  "agent.tone_invalid": () => ["Choose tones from the list.", "اختر الأسلوب من القائمة."],
  "agent.tag_unknown": () => [
    "One of the chosen tags no longer exists. Reload and choose again.",
    "أحد الوسوم المختارة لم يعد موجودًا. أعد التحميل واختر مجددًا.",
  ],
  "agent.message_invalid": (x) => [
    `Write a message of up to ${n(num(x.max, SANDBOX_MESSAGE_MAX))} characters.`,
    `اكتب رسالة لا تتجاوز ${n(num(x.max, SANDBOX_MESSAGE_MAX))} حرف.`,
  ],
  "onboarding.name_invalid": (x) => [
    `Enter your business name (up to ${n(num(x.max, BUSINESS_NAME_MAX))} characters).`,
    `أدخل اسم نشاطك التجاري (حتى ${n(num(x.max, BUSINESS_NAME_MAX))} حرف).`,
  ],
  "onboarding.step_invalid": () => ["This setup step isn't available right now. Reload the page.", "خطوة الإعداد هذه غير متاحة الآن. أعد تحميل الصفحة."],
  "agent.not_found": () => ["We couldn't find this. Reload the page.", "تعذّر العثور على هذا. أعد تحميل الصفحة."],
  "agent.version_conflict": () => [
    "Someone else changed these settings. Reload to see the latest, then save again.",
    "عدّل شخص آخر هذه الإعدادات. أعد التحميل لرؤية آخر نسخة ثم احفظ مجددًا.",
  ],
  "onboarding.not_owner": () => [
    "Another team member is setting up the agent. Ask them to finish or skip it.",
    "يقوم عضو آخر في الفريق بإعداد الوكيل. اطلب منه إكماله أو تخطيه.",
  ],
  "onboarding.done": () => ["Setup is already finished.", "اكتمل الإعداد بالفعل."],
  "onboarding.no_website": () => [
    "We haven't read your website yet. Wait for the first pages, then try again.",
    "لم نقرأ موقعك بعد. انتظر قراءة الصفحات الأولى ثم حاول مجددًا.",
  ],
  "onboarding.not_learned": () => ["Read your website first, then apply what was learned.", "اقرأ موقعك أولًا ثم طبّق ما تعلّمه الوكيل."],
  "onboarding.not_stuck": () => [
    "The setup is still in progress by another team member. You can take it over after 24 hours without progress, or if they leave the workspace.",
    "لا يزال عضو آخر يعمل على الإعداد. يمكنك تولّيه بعد 24 ساعة دون تقدم، أو إذا غادر مساحة العمل.",
  ],
  "agent.hours_invalid": (x, lang) => {
    const day = typeof x.day === "string" && WEEKDAYS.includes(x.day) ? dayName(x.day as Weekday, lang) : null;
    const en = scheduleReasonText(String(x.reason ?? ""), (e) => e);
    const ar = scheduleReasonText(String(x.reason ?? ""), (_e, a) => a);
    return day ? [`${day}: ${en}`, `${day}: ${ar}`] : [en, ar];
  },
  "agent.hours_empty": () => [
    "Add at least one working window, or choose Always on.",
    "أضف فترة عمل واحدة على الأقل، أو اختر يعمل دائمًا.",
  ],
  "agent.sandbox_rate": (x) => {
    const m = minutes(num(x.retryAfterSeconds, 60));
    return [
      `You've sent many test messages. Try again in ${m} minute${m === 1 ? "" : "s"}.`,
      `أرسلت رسائل اختبار كثيرة. حاول مجددًا بعد ${m} دقيقة.`,
    ];
  },
  "agent.ai_unavailable": () => ["The test chat isn't available right now.", "محادثة التجربة غير متاحة الآن."],
  "onboarding.ai_unavailable": () => [
    "Reading your website with AI isn't available right now. You can skip this step.",
    "قراءة موقعك بالذكاء الاصطناعي غير متاحة الآن. يمكنك تخطي هذه الخطوة.",
  ],
  "agent.ai_failed": () => ["The agent couldn't answer this time. Try again.", "لم يتمكن الوكيل من الإجابة هذه المرة. حاول مجددًا."],
  "onboarding.ai_failed": () => [
    "We couldn't summarise your website this time. Try again, or skip this step.",
    "تعذّر تلخيص موقعك هذه المرة. حاول مجددًا أو تخطَّ هذه الخطوة.",
  ],
  "agent.resync_failed": () => [
    "We couldn't reach the agent platform to re-sync. Try again in a few minutes.",
    "تعذّر الوصول إلى منصة الوكيل لإعادة المزامنة. حاول مجددًا بعد بضع دقائق.",
  ],
  // Signup (backend/src/auth/auth.controller.ts, ruling 11)
  "auth.register_rate": (x) => {
    const m = minutes(num(x.retryAfterSeconds, 3600));
    return [
      `Too many sign-ups from this network. Try again in ${m} minute${m === 1 ? "" : "s"}.`,
      `محاولات تسجيل كثيرة من هذه الشبكة. حاول مجددًا بعد ${m} دقيقة.`,
    ];
  },
};

/** The key of an ApiError body (`message`), or "". */
export function errorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return "";
  const body = err.body as Extra | undefined;
  return typeof body?.message === "string" ? body.message : err.message;
}

export function errorExtra(err: unknown): Extra {
  return err instanceof ApiError && typeof err.body === "object" && err.body !== null ? (err.body as Extra) : {};
}

export function agentKeyText(key: string | null | undefined, tx: Tx, extra: Extra = {}): string | null {
  const c = key ? AGENT_ERROR_COPY[key] : undefined;
  if (!c) return null;
  const lang = tx("en", "ar") === "ar" ? "ar" : "en";
  const [en, ar] = c(extra, lang);
  return tx(en, ar);
}

/** Localized text for anything an agent, sandbox, onboarding or signup call can throw; 403 is the shared copy. */
export function agentErrorText(err: unknown, tx: Tx, fallback?: string): string {
  if (err instanceof ApiError && err.status === 403) return tx(NO_PERMISSION_EN, NO_PERMISSION_AR);
  const known = agentKeyText(errorKey(err), tx, errorExtra(err));
  if (known) return known;
  return fallback ?? tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.");
}

/** The `current` version of a 409 `agent.version_conflict`, or null. */
export function conflictVersion(err: unknown): number | null {
  if (errorKey(err) !== "agent.version_conflict") return null;
  const c = errorExtra(err).current;
  return typeof c === "number" ? c : null;
}
