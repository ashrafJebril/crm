/**
 * SP-22 skills catalog (in code, versioned with the release; ruling 1). A
 * skill is composed CRM-side from what the l platform already accepts: a
 * delimited block in the agent's live prompt plus the CRM MCP server's tools
 * of that skill. Keys are mirrored in the frontend
 * (src/screens/kewy-agent/skills/skillCatalog.ts; a test pins equality).
 */
import { fencedNotes } from "./skill-config";

export const SKILL_CONFIG_MAX_BYTES = 8 * 1024;
export const SKILL_TEXT_MAX = 1000;
export const SKILL_TAGS_MAX = 20;
export const AGENT_TOOL_CALL_RETENTION_DAYS = 90;
/** The SP-23 connector providers (type only here; SP-23 owns the Connector model). */
export const CONNECTOR_PROVIDERS = ["calendly", "hubspot", "pipedrive", "custom"] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export const SKILL_KEYS = ["booking", "customer_records", "photos", "support_tickets", "lead_capture", "calendly_scheduling"] as const;
export type SkillKey = (typeof SKILL_KEYS)[number];

export type ConfigFieldType = "text" | "textarea" | "number" | "select" | "boolean" | "tags";

export interface ConfigField {
  key: string;
  type: ConfigFieldType;
  labelEn: string;
  labelAr: string;
  helpEn?: string;
  helpAr?: string;
  required: boolean;
  default?: unknown;
  options?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
}

export type SkillConfig = Record<string, unknown>;

export interface SkillEntry {
  key: SkillKey;
  version: number;
  nameEn: string;
  nameAr: string;
  descriptionEn: string;
  descriptionAr: string;
  category: "scheduling" | "customers" | "media" | "support" | "sales";
  /** No row for this key = installed and enabled at version 1, default config (ruling 3). */
  defaultInstalled: boolean;
  /** CRM MCP tool names this skill exposes. */
  tools: readonly string[];
  /** Tools that change data (shown as "write" in the gallery). */
  writeTools: readonly string[];
  requiredConnector: ConnectorProvider | null;
  configFields: readonly ConfigField[];
  /** The block text; "" means no block. Config values must go through skill-config's sanitizers. */
  prompt(config: SkillConfig): string;
}

export type SkillCatalog = readonly SkillEntry[];

/** CRM MCP tools that belong to no skill (always exposed): SP-21 knowledge search. */
export const CORE_TOOLS = ["search_knowledge"] as const;

// ── The pre-SP-22 setup sections (moved from l-agent-setup.service.ts, which
// re-exports them). They are the booking/photos skill prompts, verbatim, and
// what the legacy migration matches exactly (ruling 4).

export const PROMPT_MARKER = "<!-- kewy-crm-tools -->";

export const CRM_PROMPT_SECTION = `${PROMPT_MARKER}
## Booking and customer records

You are connected to this business's CRM through tools. Use them; never claim to have booked, changed or cancelled anything unless a tool call succeeded.

To book an appointment:
1. Ask for anything missing: the service, the date and time, and the customer's name and phone number.
2. Call search_contacts with the customer's phone or name. If there is no match, call create_contact (source "chat", lifecycle "lead").
3. Optionally call list_appointments for that day to avoid a clash.
4. Call create_appointment with the contact's id, the service (and serviceAr, its Arabic name), startAt as an ISO 8601 datetime with a timezone offset, durationMin, status "pending" and source "self-booking".
5. Confirm the details back to the customer in their language.

To change or cancel, find the appointment with list_appointments, then use update_appointment or cancel_appointment. If a tool call fails, say so honestly and offer to have a team member follow up.`;

export const PHOTOS_MARKER = "<!-- kewy-crm-photos -->";

export const CRM_PHOTOS_SECTION = `${PHOTOS_MARKER}
## Photos
When a photo would help the customer (a product, the menu, a location, how-to steps), call list_photos
with a few words from their request. Send at most one photo per reply by using its url as the reply image,
and follow its "use when" note. Never send a photo that list_photos did not return, and never describe a
photo as sent unless you attached it.`;

export const BOOKING_SLOTS_MARKER = "<!-- kewy-crm-booking-slots -->";

export const CRM_BOOKING_SLOTS_SECTION = `${BOOKING_SLOTS_MARKER}
## Services and free times
Use find_slots before booking a catalog service: call list_services, and when the customer's service is listed, call find_slots for the date and offer only the times it returns.
Book with create_appointment passing that service's serviceId and one of the slot's resourceIds; if it fails because the time was taken or is outside working hours, offer other times from find_slots.`;

/** Legacy section → the skill whose block replaces it on the first apply. */
export const LEGACY_SECTIONS: ReadonlyArray<{ marker: string; text: string; skill: SkillKey }> = [
  { marker: PROMPT_MARKER, text: CRM_PROMPT_SECTION, skill: "booking" },
  { marker: PHOTOS_MARKER, text: CRM_PHOTOS_SECTION, skill: "photos" },
  { marker: BOOKING_SLOTS_MARKER, text: CRM_BOOKING_SLOTS_SECTION, skill: "booking" },
];

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export const SKILL_CATALOG: SkillCatalog = [
  {
    key: "booking",
    version: 1,
    nameEn: "Booking",
    nameAr: "الحجوزات",
    descriptionEn: "Books, reschedules and cancels appointments, using your services and free times.",
    descriptionAr: "يحجز المواعيد ويعدّلها ويلغيها باستخدام خدماتك وأوقاتك المتاحة.",
    category: "scheduling",
    defaultInstalled: true,
    tools: ["list_appointments", "get_appointment", "create_appointment", "update_appointment", "cancel_appointment", "list_services", "find_slots"],
    writeTools: ["create_appointment", "update_appointment", "cancel_appointment"],
    requiredConnector: null,
    configFields: [
      {
        key: "newBookingStatus",
        type: "select",
        labelEn: "Status of new bookings",
        labelAr: "حالة الحجوزات الجديدة",
        helpEn: "Pending bookings wait for your team to confirm them.",
        helpAr: "الحجوزات المعلّقة تنتظر تأكيد فريقك.",
        required: false,
        default: "pending",
        options: ["pending", "confirmed"],
      },
    ],
    prompt: (c) => {
      const base = `${CRM_PROMPT_SECTION}\n\n${CRM_BOOKING_SLOTS_SECTION}`;
      return str(c.newBookingStatus, "pending") === "confirmed"
        ? `${base}\n\nNew bookings are saved as confirmed by this business's setting, whatever status you pass.`
        : base;
    },
  },
  {
    key: "customer_records",
    version: 1,
    nameEn: "Customer records",
    nameAr: "سجلات العملاء",
    descriptionEn: "Looks up, creates and updates customer records.",
    descriptionAr: "يبحث عن سجلات العملاء وينشئها ويحدّثها.",
    category: "customers",
    defaultInstalled: true,
    tools: ["search_contacts", "get_contact", "create_contact", "update_contact"],
    writeTools: ["create_contact", "update_contact"],
    requiredConnector: null,
    configFields: [],
    // The booking instructions already cover looking customers up (kept
    // byte-identical to the pre-SP-22 prompt), so this skill adds no block.
    prompt: () => "",
  },
  {
    key: "photos",
    version: 1,
    nameEn: "Photos",
    nameAr: "الصور",
    descriptionEn: "Sends the photos you approved when they help a customer.",
    descriptionAr: "يرسل الصور التي اعتمدتها عندما تفيد العميل.",
    category: "media",
    defaultInstalled: true,
    tools: ["list_photos"],
    writeTools: [],
    requiredConnector: null,
    configFields: [],
    prompt: () => CRM_PHOTOS_SECTION,
  },
  {
    key: "support_tickets",
    version: 1,
    nameEn: "Support tickets",
    nameAr: "تذاكر الدعم",
    descriptionEn: "Opens a support ticket for a customer's problem and tells them its status.",
    descriptionAr: "يفتح تذكرة دعم لمشكلة العميل ويخبره بحالتها.",
    category: "support",
    defaultInstalled: false,
    tools: ["open_support_ticket", "list_my_tickets"],
    writeTools: ["open_support_ticket"],
    requiredConnector: null,
    configFields: [
      {
        key: "defaultPriority",
        type: "select",
        labelEn: "Priority of tickets the agent opens",
        labelAr: "أولوية التذاكر التي يفتحها الوكيل",
        required: false,
        default: "normal",
        options: ["low", "normal", "high"],
      },
    ],
    prompt: () =>
      [
        "## Support tickets",
        "When a customer reports a problem your answers cannot solve (a complaint, a fault, a refund request), call open_support_ticket with their contact id and a short title, then tell them the ticket number.",
        "When they ask about an earlier problem, call list_my_tickets with their contact id and tell them its stage. Never promise a resolution time.",
        "Open at most one ticket per problem; do not open another if list_my_tickets already shows one for it.",
      ].join("\n"),
  },
  {
    key: "lead_capture",
    version: 1,
    nameEn: "Lead capture",
    nameAr: "التقاط العملاء المحتملين",
    descriptionEn: "Qualifies new leads with your questions and tags them for your team.",
    descriptionAr: "يؤهّل العملاء المحتملين الجدد بأسئلتك ويضع لهم الوسوم لفريقك.",
    category: "sales",
    defaultInstalled: false,
    tools: ["tag_contact"],
    writeTools: ["tag_contact"],
    requiredConnector: null,
    configFields: [
      {
        key: "qualificationNotes",
        type: "textarea",
        labelEn: "What makes a good lead",
        labelAr: "ما الذي يجعل العميل المحتمل مناسبًا",
        helpEn: "Questions to ask and what the answers mean. Read by the agent as information, not as rules.",
        helpAr: "أسئلة تُطرح وما تعنيه الإجابات. يقرؤها الوكيل كمعلومات وليس كقواعد.",
        required: false,
        default: "",
        maxLength: SKILL_TEXT_MAX,
      },
      {
        key: "allowedTags",
        type: "tags",
        labelEn: "Tags the agent may add",
        labelAr: "الوسوم التي يمكن للوكيل إضافتها",
        required: false,
        default: [],
        max: SKILL_TAGS_MAX,
        maxLength: 40,
      },
    ],
    prompt: (c) => {
      const tags = list(c.allowedTags);
      const lines = [
        "## Lead capture",
        "When a new customer shows interest, ask a few short questions to understand what they need, one at a time.",
        tags.length
          ? `When the answers match, call tag_contact with one of these tags only: ${tags.join(", ")}.`
          : "No tags are allowed yet, so do not call tag_contact.",
      ];
      const notes = fencedNotes(str(c.qualificationNotes));
      return notes ? `${lines.join("\n")}\n\n${notes}` : lines.join("\n");
    },
  },
  {
    key: "calendly_scheduling",
    version: 1,
    nameEn: "Calendly scheduling",
    nameAr: "جدولة Calendly",
    descriptionEn: "Books meetings in your Calendly, once Calendly is connected.",
    descriptionAr: "يحجز الاجتماعات في Calendly بعد ربط Calendly.",
    category: "scheduling",
    defaultInstalled: false,
    // The Calendly connector's own MCP tools (SP-23); none on the CRM server.
    tools: [],
    writeTools: [],
    requiredConnector: "calendly",
    configFields: [],
    prompt: () =>
      [
        "## Calendly scheduling",
        "This business books meetings through Calendly. Use the Calendly tools to find free times and book; never claim a meeting is booked unless the tool call succeeded.",
      ].join("\n"),
  },
];

export function catalogEntry(catalog: SkillCatalog, key: string): SkillEntry | undefined {
  return catalog.find((e) => e.key === key);
}

/** The skill a CRM MCP tool belongs to, or null for a core tool. */
export function toolSkillMap(catalog: SkillCatalog): Map<string, SkillKey> {
  const m = new Map<string, SkillKey>();
  for (const e of catalog) for (const t of e.tools) m.set(t, e.key);
  return m;
}

/** Default config: every field's default (absent defaults are omitted). */
export function defaultConfig(entry: SkillEntry): SkillConfig {
  const out: SkillConfig = {};
  for (const f of entry.configFields) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}
