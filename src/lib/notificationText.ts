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
    case "assignment.conversation":
      return out(tx("Conversation assigned to you", "تم إسناد محادثة إليك"), str(p.contactName));
    case "assignment.ticket":
      return out(tx("Ticket assigned to you", "تم إسناد تذكرة إليك"), str(p.ticketTitle));
    case "mention.note":
      return out(tx("You were mentioned in a note", "تمت الإشارة إليك في ملاحظة"), str(p.excerpt));
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
    }
  }
  return { title: n.title };
}
