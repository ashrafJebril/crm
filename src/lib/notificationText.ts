import { lastErrorText } from "@/screens/campaigns/campaignErrors";
import { changeText, type HealthChange } from "@/screens/channels/health/healthModel";
import type { Tx } from "./tx";

export interface NotificationLike {
  type: string;
  title: string;
  body: string | null;
  recordKind?: string | null;
  recordId?: string | null;
}

type Params = Record<string, unknown>;

function parseParams(body: string | null): Params {
  if (!body) return {};
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Params) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v : undefined;

const KEY_SHAPE = /^[a-z_]+(\.[a-z_]+)+$/;

/** Maps a notification's message key + JSON params to localized text.
 *  Unknown, non-key titles are shown as-is. */
export function notificationText(tx: Tx, n: NotificationLike): { title: string; body?: string } {
  const p = parseParams(n.body);
  const out = (title: string, body?: string) => (body ? { title, body } : { title });
  switch (n.title) {
    case "assignment.conversation": {
      const actor = str(p.actorName);
      const contact = str(p.contactName);
      if (actor) {
        return out(
          contact
            ? tx(`${actor} assigned you a conversation with ${contact}`, `أسندت إليك ${actor} محادثة مع ${contact}`)
            : tx(`${actor} assigned you a conversation`, `أسندت إليك ${actor} محادثة`),
        );
      }
      return out(tx("Conversation assigned to you", "تم إسناد محادثة إليك"), contact);
    }
    case "assignment.ticket": {
      const actor = str(p.actorName);
      const ticket = str(p.ticketTitle);
      if (actor) {
        return out(
          ticket
            ? tx(`${actor} assigned you a ticket: ${ticket}`, `أسندت إليك ${actor} تذكرة: ${ticket}`)
            : tx(`${actor} assigned you a ticket`, `أسندت إليك ${actor} تذكرة`),
        );
      }
      return out(tx("Ticket assigned to you", "تم إسناد تذكرة إليك"), ticket);
    }
    case "activity.due": {
      const title = str(p.title);
      const contact = str(p.contactName);
      const kind = str(p.kind);
      const label =
        kind === "call" ? tx("Call due", "موعد مكالمة")
        : kind === "meeting" ? tx("Meeting due", "موعد اجتماع")
        : kind === "task" ? tx("Task due", "موعد مهمة")
        : tx("Follow-up due", "موعد متابعة");
      return out(title ? `${label}: ${title}` : label, contact);
    }
    case "assignment.activity": {
      const title = str(p.title);
      const contact = str(p.contactName);
      const count = typeof p.count === "number" ? p.count : undefined;
      if (count && count > 1) {
        return out(tx(`${count} activities assigned to you`, `أُسندت إليك ${count} أنشطة`));
      }
      return out(
        title ? tx(`Activity assigned to you: ${title}`, `أُسند إليك نشاط: ${title}`) : tx("Activity assigned to you", "أُسند إليك نشاط"),
        contact,
      );
    }
    case "campaign.launch_failed": {
      // SP-13: the background launch failed; `error` is a campaigns.* key (or older provider text).
      const name = str(p.name);
      const error = lastErrorText(str(p.error), tx) ?? undefined;
      return out(
        name
          ? tx(`Campaign “${name}” couldn't be sent`, `تعذّر إرسال الحملة «${name}»`)
          : tx("A campaign couldn't be sent", "تعذّر إرسال حملة"),
        error,
      );
    }
    case "channel.health_downgraded": {
      // SP-14: body {channelId, name, phone, changes: [{signal, from, to}]}.
      const name = str(p.name) ?? str(p.phone) ?? tx("A WhatsApp number", "رقم واتساب");
      const changes = Array.isArray(p.changes)
        ? (p.changes as unknown[]).filter(
            (x): x is HealthChange => !!x && typeof x === "object" && typeof (x as HealthChange).signal === "string",
          )
        : [];
      const words = changes.map((ch) => changeText(ch, tx));
      if (words.length === 0) return out(tx(`${name} needs attention`, `${name} يحتاج إلى انتباه`));
      return out(
        tx(`${name} needs attention: ${words[0]}`, `${name} يحتاج إلى انتباه: ${words[0]}`),
        words.length > 1 ? words.slice(1).join(tx("; ", "؛ ")) : undefined,
      );
    }
    case "connectors.needs_reconnect": {
      // SP-23: body {provider, name, reason, connectorId}.
      const name = str(p.name) ?? str(p.provider) ?? tx("A connector", "موصل");
      return out(tx(`${name} needs reconnecting`, `يحتاج ${name} إلى إعادة الربط`));
    }
    case "meta_ads.needs_reconnect": {
      // SP-15: body {reason: "token_refused"|"account_refused", adAccountName}.
      const name = str(p.adAccountName);
      const reason =
        p.reason === "token_refused" ? tx("Meta refused the login", "رفضت Meta تسجيل الدخول")
        : p.reason === "account_refused" ? tx("Meta refused access to the ad account", "رفضت Meta الوصول إلى الحساب الإعلاني")
        : undefined;
      return out(
        name
          ? tx(`Meta Ads needs reconnecting: ${name}`, `يحتاج حساب إعلانات Meta إلى إعادة ربط: ${name}`)
          : tx("Meta Ads needs reconnecting", "يحتاج حساب إعلانات Meta إلى إعادة ربط"),
        reason,
      );
    }
    case "lifecycle.ticket_opened":
    case "lifecycle.new_lead": {
      const lead = n.title === "lifecycle.new_lead";
      const num = typeof p.number === "number" || typeof p.number === "string" ? String(p.number) : undefined;
      const contact = str(p.contactName);
      const title = str(p.title);
      const head = lead
        ? num
          ? tx(`New lead #${num}`, `عميل محتمل جديد رقم ${num}`)
          : tx("New lead", "عميل محتمل جديد")
        : num
          ? tx(`New ticket #${num}`, `تذكرة جديدة رقم ${num}`)
          : tx("New ticket", "تذكرة جديدة");
      return out(contact ? `${head} · ${contact}` : head, title);
    }
    case "webhooks.endpoint_disabled": {
      // SP-27: body {endpointId, url, reason: "failing"|"unsafe_url"}.
      const url = str(p.url);
      const why =
        p.reason === "unsafe_url"
          ? tx("Its URL now points to a private or blocked address.", "يشير رابطه الآن إلى عنوان خاص أو محظور.")
          : tx("Deliveries failed for 72 hours.", "فشل التسليم لمدة 72 ساعة.");
      return out(tx("A webhook was turned off", "تم إيقاف ويب هوك"), url ? `${url} · ${why}` : why);
    }
    case "import.failed":
      return out(tx("An import failed", "فشل الاستيراد"));
    case "mention.note": {
      const actor = str(p.actorName);
      const excerpt = str(p.excerpt);
      return actor
        ? out(tx(`${actor} mentioned you in a note`, `أشارت إليك ${actor} في ملاحظة`), excerpt)
        : out(tx("You were mentioned in a note", "تمت الإشارة إليك في ملاحظة"), excerpt);
    }
  }
  if (KEY_SHAPE.test(n.title)) {
    const detail = str(p.name) ?? str(p.title) ?? str(p.excerpt) ?? str(p.message);
    switch (n.type) {
      case "activity_due":
        return out(tx("An activity is due", "هناك نشاط مستحق"), detail);
      case "connector_needs_attention":
        return out(tx("A connection needs attention", "اتصال يحتاج إلى انتباهك"), detail);
      case "knowledge_source_failed":
        return out(tx("A knowledge source failed to sync", "تعذّرت مزامنة مصدر معرفة"), detail);
      case "campaign_finished":
        return out(tx("A campaign has finished", "انتهت حملة"), detail);
      case "import_finished":
        return out(tx("An import has finished", "اكتمل الاستيراد"), detail);
      case "assignment":
        return out(tx("New assignment", "إسناد جديد"), detail);
      case "mention":
        return out(tx("You were mentioned", "تمت الإشارة إليك"), detail);
      case "lifecycle":
        return out(tx("Automatic message alert", "تنبيه من الرسائل التلقائية"), detail);
    }
  }
  return { title: n.title };
}
