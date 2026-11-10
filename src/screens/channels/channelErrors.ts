import { ApiError } from "@/api/client";
import { arabicServerMessage } from "@/lib/roleErrors";
import type { Tx } from "@/lib/tx";

/**
 * Localized copy for every SP-19 error key and channel statusReason the
 * backend sends (T1–T4 reports). Pure: no React, so it is unit-tested for
 * completeness (every key has English and Arabic).
 *
 * The backend puts the key in `message` and extras next to it
 * (`{statusCode, message: "channels.limit_reached", limit, plan}`), which
 * `ApiError` exposes as `.message` and `.body`.
 */

export interface Copy {
  en: string;
  ar: string;
}

type Extra = Record<string, unknown>;
type CopyFn = (x: Extra) => Copy;

const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;

const planName = (v: unknown): Copy => {
  const p = str(v)?.toLowerCase() ?? "";
  const names: Record<string, Copy> = {
    free: { en: "Free", ar: "المجانية" },
    starter: { en: "Starter", ar: "المبتدئة" },
    growth: { en: "Growth", ar: "النمو" },
    pro: { en: "Pro", ar: "الاحترافية" },
  };
  return names[p] ?? { en: p || "current", ar: p || "الحالية" };
};

const FIELD: Record<string, Copy> = {
  allowedOrigins: { en: "allowed websites", ar: "المواقع المسموح بها" },
  greeting: { en: "English greeting", ar: "الترحيب بالإنجليزية" },
  greetingAr: { en: "Arabic greeting", ar: "الترحيب بالعربية" },
  color: { en: "colour", ar: "اللون" },
  position: { en: "position", ar: "الموضع" },
  askName: { en: "ask for name", ar: "طلب الاسم" },
  lang: { en: "language", ar: "اللغة" },
  cc: { en: "country code", ar: "رمز الدولة" },
  phoneNumber: { en: "phone number", ar: "رقم الهاتف" },
  verifiedName: { en: "display name", ar: "الاسم الظاهر" },
  method: { en: "call method", ar: "طريقة الاتصال" },
  language: { en: "call language", ar: "لغة المكالمة" },
  code: { en: "verification code", ar: "رمز التحقق" },
  body: { en: "message", ar: "الرسالة" },
  name: { en: "name", ar: "الاسم" },
};
const fieldName = (v: unknown): Copy | null => {
  const f = str(v);
  return f ? (FIELD[f] ?? { en: f, ar: f }) : null;
};

const metaRef = (x: Extra): Copy => {
  const c = str(x.metaCode);
  return c ? { en: ` (Meta code ${c})`, ar: ` (رمز Meta ${c})` } : { en: "", ar: "" };
};

const seconds = (x: Extra): number | null => {
  const n = Number(x.retryAfter);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
};

/** Every error key the channel routes, the widget and the Meta flows can return. */
export const CHANNEL_ERROR_COPY: Record<string, CopyFn> = {
  "channels.not_found": () => ({
    en: "This channel no longer exists.",
    ar: "هذه القناة لم تعد موجودة.",
  }),
  "channels.limit_reached": (x) => {
    const limit = str(x.limit);
    const plan = planName(x.plan);
    return limit
      ? {
          en: `Your ${plan.en} plan allows ${limit} WhatsApp ${limit === "1" ? "number" : "numbers"}. Disconnect one or upgrade your plan to add another.`,
          ar: `تسمح باقتك ${plan.ar} بـ ${limit} من أرقام واتساب. افصل رقمًا أو رقِّ باقتك لإضافة رقم آخر.`,
        }
      : {
          en: "You've reached your plan's WhatsApp number limit. Disconnect one or upgrade your plan.",
          ar: "وصلت إلى حد أرقام واتساب في باقتك. افصل رقمًا أو رقِّ باقتك.",
        };
  },
  "channels.disconnected": () => ({
    en: "This channel is disconnected. Reconnect it to send replies.",
    ar: "هذه القناة مفصولة. أعد ربطها لإرسال الردود.",
  }),
  "channels.not_connected": () => ({
    en: "No connected channel can send this message yet.",
    ar: "لا توجد قناة متصلة يمكنها إرسال هذه الرسالة بعد.",
  }),
  "channels.already_connected": () => ({
    en: "This account is already connected in this workspace.",
    ar: "هذا الحساب مربوط بالفعل في مساحة العمل هذه.",
  }),
  "channels.connected_elsewhere": () => ({
    en: "This account is connected to another workspace. Disconnect it there first.",
    ar: "هذا الحساب مربوط بمساحة عمل أخرى. افصله من هناك أولًا.",
  }),
  "channels.default_requires_active": () => ({
    en: "Only an active channel can be the default.",
    ar: "يمكن فقط للقناة النشطة أن تكون الافتراضية.",
  }),
  "channels.default_conflict": () => ({
    en: "Someone changed the default at the same time. Refresh and try again.",
    ar: "غيّر شخص آخر القناة الافتراضية في الوقت نفسه. حدّث الصفحة وحاول مجددًا.",
  }),
  "channels.default_required": () => ({
    en: "A kind of channel always keeps one default. Make another channel the default instead.",
    ar: "يجب أن تبقى قناة افتراضية لكل نوع. اجعل قناة أخرى هي الافتراضية بدلًا من ذلك.",
  }),
  "channels.sender_invalid": () => ({
    en: "The chosen sender is not an active WhatsApp number of this workspace.",
    ar: "المُرسِل المختار ليس رقم واتساب نشطًا في مساحة العمل هذه.",
  }),
  "channels.encryption_unavailable": () => ({
    en: "Secret encryption is not set up on the server (TOKEN_ENC_KEY), so new channel credentials can't be stored. Ask your administrator.",
    ar: "تشفير البيانات السرية غير مُعدّ على الخادم (TOKEN_ENC_KEY)، لذا لا يمكن حفظ بيانات اعتماد القنوات الجديدة. تواصل مع المسؤول.",
  }),
  "channels.transport_unavailable": () => ({
    en: "This channel can't send from here.",
    ar: "لا يمكن الإرسال من هذه القناة هنا.",
  }),
  "channels.invalid_config": (x) => {
    const f = fieldName(x.field);
    return f
      ? { en: `Check the ${f.en} and try again.`, ar: `تحقّق من ${f.ar} وحاول مجددًا.` }
      : { en: "Some settings are not valid. Check them and try again.", ar: "بعض الإعدادات غير صالحة. تحقّق منها وحاول مجددًا." };
  },
  "channels.telegram_invalid_token": () => ({
    en: "Telegram rejected this bot token. Copy it again from @BotFather.",
    ar: "رفض تيليجرام رمز البوت هذا. انسخه مجددًا من ‎@BotFather.",
  }),
  "channels.telegram_needs_public_url": () => ({
    en: "Telegram needs the server's public HTTPS address (PUBLIC_BASE_URL). Ask your administrator.",
    ar: "يحتاج تيليجرام إلى عنوان HTTPS العام للخادم (PUBLIC_BASE_URL). تواصل مع المسؤول.",
  }),
  "channels.telegram_send_failed": (x) => {
    const reason = str(x.reason);
    if (reason === "no_chat") {
      return { en: "This Telegram chat can't be reached.", ar: "لا يمكن الوصول إلى محادثة تيليجرام هذه." };
    }
    return {
      en: `Telegram didn't deliver the message${reason ? `: ${reason}` : "."}`,
      ar: `لم يُسلّم تيليجرام الرسالة${reason ? `: ${reason}` : "."}`,
    };
  },
  "channels.webhook_forbidden": () => ({
    en: "The webhook request was refused.",
    ar: "رُفض طلب الـ Webhook.",
  }),
  "channels.embedded_signup_unavailable": (x) => {
    const reason = str(x.reason);
    if (reason && reason !== "channels.embedded_signup_unavailable" && CHANNEL_ERROR_COPY[reason]) {
      return CHANNEL_ERROR_COPY[reason]!({});
    }
    return {
      en: "Connect with Meta isn't available right now. Use a token or Zernio instead.",
      ar: "الربط عبر Meta غير متاح حاليًا. استخدم الرمز أو Zernio بدلًا من ذلك.",
    };
  },
  "channels.embedded_signup_not_configured": () => ({
    en: "Connect with Meta isn't set up for this server yet. You can still connect a number with a token or through Zernio.",
    ar: "الربط عبر Meta غير مُعدّ لهذا الخادم بعد. لا يزال بإمكانك ربط رقم برمز وصول أو عبر Zernio.",
  }),
  "channels.embedded_signup_failed": (x) => {
    const step = str(x.step);
    const m = metaRef(x);
    if (step === "waba") {
      return {
        en: `Meta didn't tell us which WhatsApp Business account to use. Run the signup again and pick one account.${m.en}`,
        ar: `لم تحدد Meta حساب واتساب للأعمال المطلوب. أعد التسجيل واختر حسابًا واحدًا.${m.ar}`,
      };
    }
    if (step === "phone") {
      return {
        en: `Meta didn't return the phone number's details. Try again.${m.en}`,
        ar: `لم تُرجع Meta تفاصيل رقم الهاتف. حاول مجددًا.${m.ar}`,
      };
    }
    return {
      en: `Meta didn't accept the signup. Run it again.${m.en}`,
      ar: `لم تقبل Meta عملية التسجيل. أعد المحاولة.${m.ar}`,
    };
  },
  "channels.meta_token_invalid": () => ({
    en: "Meta rejected this access token. Generate a new one and try again.",
    ar: "رفضت Meta رمز الوصول هذا. أنشئ رمزًا جديدًا وحاول مجددًا.",
  }),
  "channels.meta_no_waba": () => ({
    en: "This token can't see any WhatsApp Business account.",
    ar: "لا يصل هذا الرمز إلى أي حساب واتساب للأعمال.",
  }),
  "channels.meta_no_number": () => ({
    en: "This token has no WhatsApp number this workspace can add or refresh.",
    ar: "لا يحتوي هذا الرمز على رقم واتساب يمكن لمساحة العمل إضافته أو تحديثه.",
  }),
  "channels.landline_wrong_code": () => ({
    en: "That code doesn't match. Check the digits, or ask Meta to call again.",
    ar: "الرمز غير مطابق. تحقّق من الأرقام، أو اطلب من Meta الاتصال مرة أخرى.",
  }),
  "channels.landline_rate_limited": () => ({
    en: "Meta paused verification for this number after too many attempts. Try again later; Meta usually lifts it within 24 hours. Your setup is saved.",
    ar: "أوقفت Meta التحقق لهذا الرقم بعد محاولات كثيرة. حاول لاحقًا، وعادةً ترفعه Meta خلال 24 ساعة. إعدادك محفوظ.",
  }),
  "channels.landline_cooldown": (x) => {
    const s = seconds(x);
    return s
      ? { en: `Meta just called. Wait ${s}s before asking for another call.`, ar: `اتصلت Meta للتو. انتظر ${s} ث قبل طلب مكالمة أخرى.` }
      : { en: "Meta just called. Wait a minute before asking for another call.", ar: "اتصلت Meta للتو. انتظر دقيقة قبل طلب مكالمة أخرى." };
  },
  "channels.landline_number_in_use": () => ({
    en: "This number is already on a WhatsApp account. Delete that account in the WhatsApp app first, or use another number.",
    ar: "هذا الرقم مسجّل على حساب واتساب. احذف ذلك الحساب من تطبيق واتساب أولًا، أو استخدم رقمًا آخر.",
  }),
  "channels.landline_invalid_input": (x) => {
    const f = fieldName(x.field);
    return f
      ? { en: `Check the ${f.en} and try again.`, ar: `تحقّق من ${f.ar} وحاول مجددًا.` }
      : {
          en: "Check the country code, phone number and display name, then try again.",
          ar: "تحقّق من رمز الدولة ورقم الهاتف والاسم الظاهر، ثم حاول مجددًا.",
        };
  },
  "channels.landline_wrong_state": () => ({
    en: "This step isn't available right now. Refresh to see where the number stands.",
    ar: "هذه الخطوة غير متاحة الآن. حدّث الصفحة لمعرفة حالة الرقم.",
  }),
  "channels.landline_meta_error": (x) => {
    const m = metaRef(x);
    return { en: `Meta refused this step.${m.en} Try again later.`, ar: `رفضت Meta هذه الخطوة.${m.ar} حاول لاحقًا.` };
  },
  "channels.zernio_reauth_required": () => ({
    en: "Zernio needs you to sign in to this account again.",
    ar: "يطلب Zernio تسجيل الدخول إلى هذا الحساب مجددًا.",
  }),
  // ── SP-14 number health (POST /channels/:id/health/check) ──
  "channels.health_unsupported": (x) => {
    const p = str(x.provider);
    return p
      ? {
          en: `Health checks aren't available for numbers connected through ${p}.`,
          ar: `فحص الحالة غير متاح للأرقام المربوطة عبر ${p}.`,
        }
      : { en: "Health checks aren't available for this channel.", ar: "فحص الحالة غير متاح لهذه القناة." };
  },
  "channels.health_check_cooldown": (x) => {
    const s = seconds(x);
    return s
      ? { en: `This number was just checked. Try again in ${s}s.`, ar: `فُحص هذا الرقم للتو. حاول مجددًا بعد ${s} ث.` }
      : { en: "This number was just checked. Try again in a minute.", ar: "فُحص هذا الرقم للتو. حاول مجددًا بعد دقيقة." };
  },
  "channels.health_check_busy": (x) => {
    const s = seconds(x);
    return s
      ? {
          en: `Too many checks in this workspace right now. Try again in ${s}s.`,
          ar: `عدد الفحوصات في مساحة العمل هذه كبير الآن. حاول مجددًا بعد ${s} ث.`,
        }
      : {
          en: "Too many checks in this workspace right now. Try again in a minute.",
          ar: "عدد الفحوصات في مساحة العمل هذه كبير الآن. حاول مجددًا بعد دقيقة.",
        };
  },
  "widget.origin_forbidden": () => ({
    en: "This website isn't in the chat's allowed websites.",
    ar: "هذا الموقع ليس ضمن المواقع المسموح لها بالمحادثة.",
  }),
  "widget.rate_limited": (x) => {
    const s = seconds(x);
    return s
      ? { en: `Too many messages. Try again in ${s}s.`, ar: `رسائل كثيرة جدًا. حاول مجددًا بعد ${s} ث.` }
      : { en: "Too many messages. Try again shortly.", ar: "رسائل كثيرة جدًا. حاول مجددًا بعد قليل." };
  },
  "widget.channel_unavailable": () => ({
    en: "This chat is not available.",
    ar: "هذه المحادثة غير متاحة.",
  }),
  "widget.visitor_forbidden": () => ({
    en: "This chat session has expired. Reload the page.",
    ar: "انتهت جلسة المحادثة. أعد تحميل الصفحة.",
  }),
  "widget.invalid_message": (x) =>
    str(x.field) === "name"
      ? { en: "The name is too long (80 characters at most).", ar: "الاسم طويل جدًا (80 حرفًا كحد أقصى)." }
      : { en: "Messages must be 1 to 2000 characters.", ar: "يجب أن تكون الرسالة من 1 إلى 2000 حرف." },
};

/** Every statusReason the backend writes on a Channel row. */
export const STATUS_REASON_COPY: Record<string, Copy> = {
  disconnected_by_user: {
    en: "Disconnected by a team member. History is kept.",
    ar: "فصلها أحد أعضاء الفريق. السجل محفوظ.",
  },
  zernio_account_missing: {
    en: "Zernio no longer lists this account. Sync to check again, or reconnect it.",
    ar: "لم يعد Zernio يُدرج هذا الحساب. زامِن للتحقق مجددًا، أو أعد ربطه.",
  },
  integration_removed: {
    en: "The connection was removed in Settings. Reconnect it to send replies.",
    ar: "أُزيل الربط من الإعدادات. أعد الربط لإرسال الردود.",
  },
  merged: {
    en: "Merged into this account's new connection. Its conversations moved there.",
    ar: "دُمجت مع الربط الجديد لهذا الحساب، وانتقلت محادثاتها إليه.",
  },
  meta_register_failed: {
    en: "Meta didn't finish registering this number. Try again.",
    ar: "لم تُكمل Meta تسجيل هذا الرقم. حاول مجددًا.",
  },
  meta_subscribe_failed: {
    en: "Meta didn't subscribe the app to this account, so messages may not arrive. Reconnect to retry.",
    ar: "لم تشترك Meta بالتطبيق في هذا الحساب، لذا قد لا تصل الرسائل. أعد الربط للمحاولة مجددًا.",
  },
  telegram_webhook_failed: {
    en: "Telegram didn't accept the webhook. Reconnect to retry.",
    ar: "لم يقبل تيليجرام الـ Webhook. أعد الربط للمحاولة مجددًا.",
  },
  telegram_save_failed: {
    en: "The bot was checked but couldn't be saved. Reconnect to retry.",
    ar: "تم التحقق من البوت لكن تعذّر حفظه. أعد الربط للمحاولة مجددًا.",
  },
};

/**
 * Zernio's account-health reasons arrive as English sentences
 * (`zernio-account-health.ts`). Map the known shapes; anything else keeps the
 * English text and gets a generic Arabic line.
 */
function zernioHealthCopy(reason: string): Copy | null {
  let m: RegExpExecArray | null;
  if ((m = /^Meta removed access on (\S+?)\.?\s/i.exec(reason + " "))) {
    return { en: reason, ar: `أزالت Meta الوصول بتاريخ ${m[1]}. اربطه مجددًا.` };
  }
  if (/sign-in expired/i.test(reason)) return { en: reason, ar: "انتهت صلاحية تسجيل الدخول. اربطه مجددًا." };
  if (/no longer connected in Zernio/i.test(reason)) {
    return { en: reason, ar: "لم يعد هذا الحساب مربوطًا في Zernio. اربطه مجددًا." };
  }
  if ((m = /platform reports it as ([^.]+)\./i.exec(reason))) {
    return { en: reason, ar: `تُبلغ المنصة أن حالته ${m[1]}. اربطه مجددًا.` };
  }
  if (/marked this account inactive/i.test(reason)) {
    return { en: reason, ar: "وضع Zernio هذا الحساب كغير نشط. اربطه مجددًا." };
  }
  return null;
}

/** Copy for a statusReason, or null when there is none. Unknown reasons keep their text. */
export function statusReasonCopy(reason: string | null | undefined): Copy | null {
  if (!reason) return null;
  const known = STATUS_REASON_COPY[reason];
  if (known) return known;
  if (CHANNEL_ERROR_COPY[reason]) return CHANNEL_ERROR_COPY[reason]!({});
  const z = zernioHealthCopy(reason);
  if (z) return z;
  return { en: reason, ar: "توقف هذا الربط عن العمل. اربطه مجددًا." };
}

/** Copy for an error key plus its extras, or null when the key is unknown. */
export function channelErrorCopy(key: string, extra: Extra = {}): Copy | null {
  const fn = CHANNEL_ERROR_COPY[key];
  return fn ? fn(extra) : null;
}

const looksLikeKey = (m: string) => /^[a-z]+\.[a-z_]+$/.test(m);

/** The extras of an ApiError body (`{statusCode, message, ...extra}`). */
export function errorExtras(e: unknown): Extra {
  if (e instanceof ApiError && e.body && typeof e.body === "object" && !Array.isArray(e.body)) {
    return e.body as Extra;
  }
  return {};
}

/**
 * Localized text for anything a channel call can throw: a key-style ApiError,
 * a legacy English message, or a network error.
 */
export function channelErrorText(e: unknown, tx: Tx): string {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const copy = message ? channelErrorCopy(message, errorExtras(e)) : null;
  if (copy) return tx(copy.en, copy.ar);
  if (e instanceof ApiError && e.status === 403 && (!message || message === "Forbidden" || message === "Missing permission")) {
    return tx("You don't have permission to do this", "ليست لديك صلاحية للقيام بذلك");
  }
  if (!message || looksLikeKey(message) || /^HTTP \d+$/.test(message) || message === "Failed to fetch") {
    return tx("Something went wrong. Try again.", "حدث خطأ ما. حاول مجددًا.");
  }
  const ar = arabicServerMessage(message);
  return tx(message, ar ?? message);
}

/**
 * m1: a send error kept as a string by useMutation (Zernio / Meta routes).
 * A known channel key (`channels.not_connected`, `channels.disconnected`…)
 * gets its localized copy; any other text is shown unchanged.
 */
export function sendErrorText(message: string | null, tx: Tx): string | null {
  if (!message) return null;
  const copy = channelErrorCopy(message);
  return copy ? tx(copy.en, copy.ar) : message;
}

/** The `field` an invalid_config / landline_invalid_input error points at. */
export function errorField(e: unknown): string | null {
  const f = errorExtras(e).field;
  return typeof f === "string" ? f : null;
}
