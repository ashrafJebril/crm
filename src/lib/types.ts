export type Theme = "dark" | "light";
export type Accent = "green" | "indigo" | "amber" | "magenta";
export type Density = "compact" | "regular" | "cozy";
export type Lang = "en" | "ar";

export interface Tweaks {
  theme: Theme;
  accent: Accent;
  density: Density;
  lang: Lang;
  collapsed: boolean;
  showAIPersonality: boolean;
}

export type RouteId =
  | "dashboard"
  | "inbox"
  | "calendar"
  | "social"
  | "media"
  | "pipeline"
  | "campaigns"
  | "contacts"
  | "followups"
  | "workflows"
  | "analytics"
  | "templates"
  | "team"
  | "agent"
  | "settings"
  | "channels"
  | "ads"
  | "admin";

// ─── Pipeline / Tickets API shapes ────────────────────────────────────────

export type StageColor = "ink" | "info" | "ok" | "warn" | "bad" | "accent" | "human";

export interface TicketStage {
  id: string;
  pipelineId: string;
  key: string;
  label: string;
  labelAr: string;
  color: StageColor;
  order: number;
  groupKey: "new" | "discovery" | "quoted" | "payment" | "fulfill" | "done" | string;
  isTerminal: boolean;
  isWon: boolean;
  slaMinutes: number | null;
}

export interface Pipeline {
  id: string;
  key: string;
  name: string;
  nameAr: string;
  isDefault: boolean;
  stages: TicketStage[];
  _count?: { tickets: number };
  version?: number;
  archivedAt?: string | null;
  staleDays?: number | null;
  agentCanMove?: boolean;
  assignsConversations?: boolean;
  kind?: "deals" | "support" | string;
}

export interface TicketContact {
  id: string;
  name: string;
  phone: string;
  industry: string;
}

export interface Ticket {
  id: string;
  number: number;
  pipelineId: string;
  stageId: string;
  contactId: string;
  conversationId: string | null;
  ownerId: string | null;
  title: string;
  description: string | null;
  value: number | null;
  currency: string;
  lostReason: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  enteredStageAt: string;
  contact?: TicketContact;
  stage?: TicketStage;
  /** SP-09: "urgent" | "high" | "normal" | "low"; legacy rows read "normal". */
  priority?: TicketPriority | string;
  /** SP-09: a TICKET_CATEGORIES key, null = not set. */
  category?: TicketCategory | string | null;
  /** SP-09: set by the database on stage entry; null = no SLA (or terminal). */
  slaDueAt?: string | null;
  /** SP-09: derived from the linked conversation; null when none or hidden.
   *  Absent on realtime payloads (raw rows). */
  channel?: TicketChannel | null;
  /** SP-09: files the viewer can open. Absent on realtime payloads. */
  attachmentCount?: number;
}

/** SP-09 (mirrors backend/src/tickets/ticket-fields.ts). */
export type TicketPriority = "urgent" | "high" | "normal" | "low";
export type TicketCategory =
  | "general_inquiry"
  | "complaint"
  | "service_request"
  | "payment_problem"
  | "execution_delay"
  | "incorrect_data"
  | "ticket_follow_up"
  | "data_modification"
  | "other";

export interface TicketChannel {
  kind: string;
  channelId: string | null;
  displayName: string | null;
}

/** SP-09: GET /tickets/:id/attachments item. `url` is an API path served with auth. */
export interface TicketAttachment {
  id: string;
  ticketId: string;
  mediaId: string;
  source: "customer" | "staff";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  messageId: string | null;
  addedBy: { id: string; name: string } | null;
  createdAt: string;
  url: string;
}

/** SP-09: GET /tickets/:id/attachments/candidates item (customer files not yet linked). */
export interface TicketAttachmentCandidate {
  mediaId: string;
  messageId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  at: string;
}

/** SP-09: GET /tickets/:id/bookings item. */
export interface TicketBookingCard {
  id: string;
  startAt: string;
  durationMin: number;
  status: AppointmentStatus | string;
  service: string;
  serviceAr: string;
  staffId: string | null;
  source: string;
  hjzSyncError: string | null;
}

export interface TicketsListPage {
  items: Ticket[];
  nextCursor: string | null;
}

export interface TicketActivity {
  id: string;
  ticketId: string;
  kind: "created" | "stage_changed" | "owner_changed" | "value_changed" | "note" | "won" | "lost";
  note: string | null;
  fromStage: string | null;
  toStage: string | null;
  byUserId: string | null;
  createdAt: string;
}

export interface TicketDetail extends Ticket {
  pipeline: Pipeline;
  activities: TicketActivity[];
}

export interface TicketsDashboardSummary {
  openValue: number;
  currency: string;
  winRate: number;
  wonCount: number;
  lostCount: number;
  avgCloseHours: number;
  totalTickets: number;
}

// "l" is the agent platform. Conversations arrive over its webhook rather than
// from a social network, but they are ordinary inbox threads once here — and
// omitting the channel from this union is not a no-op: the inbox filters on a
// Set seeded from it, so an unlisted channel is silently dropped from the list.
export type ConvChannel =
  | "whatsapp"
  | "instagram"
  | "facebook"
  | "tiktok"
  | "webchat"
  | "telegram"
  | "l";

export const CHANNEL_LABEL: Record<ConvChannel, string> = {
  whatsapp:  "WhatsApp",
  instagram: "Instagram",
  facebook:  "Facebook",
  tiktok:    "TikTok",
  webchat:   "Web chat",
  telegram:  "Telegram",
  l:         "AI Agent",
};

export type SocialPlatform = "facebook" | "instagram" | "tiktok";

export const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  facebook:  "Facebook",
  instagram: "Instagram",
  tiktok:    "TikTok",
};

export interface SocialComment {
  id: string;
  author: string;
  authorHandle: string;
  body: string;
  bodyAr?: string;
  likes: number;
  at: string;     // human-readable like "2h"
  liked?: boolean;
  accountId?: string | null;
}

export interface SocialPost {
  id: string;
  platform: SocialPlatform;
  author: string;
  authorHandle: string;
  authorVerified?: boolean;
  body: string;
  bodyAr?: string;
  mediaLabel?: string; // text label for the placeholder image
  postedAt: string;
  likes: number;
  shares: number;
  views?: number;       // tiktok-style
  comments: SocialComment[];
}

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  initials: string;
  color: string;
  email?: string;
}

export interface ConversationLabel {
  id: string;
  name: string;
  color: "ink" | "info" | "ok" | "warn" | "bad" | "accent" | "human";
  count: number;
}

export interface Contact {
  id: string;
  name: string;
  phone: string;
  tags: string[];
  industry: string;
  lifecycle: string;
  lastSeen: string;
  source: string;
  convs: number;
  value: string;
  firstName?: string;
  lastName?: string;
  /** "" when none. */
  email?: string;
  ownerId?: string | null;
  marketingOptOut?: boolean;
  notALead?: boolean;
  createdAt?: string;
}

export type CustomFieldType = "text" | "number" | "date" | "select" | "boolean";

export interface CustomFieldDef {
  id: string;
  key: string;
  label: string;
  labelAr: string;
  type: CustomFieldType;
  options: string[] | null;
  order: number;
  archivedAt: string | null;
}

export interface ContactFieldValue {
  defId: string;
  key: string;
  label: string;
  labelAr: string;
  type: CustomFieldType;
  options: string[] | null;
  value: string | number | boolean | null;
}

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface Message {
  /**
   * 'ai' is a reply generated by the Kewy AI agent. It is outbound like
   * 'human' — the salon speaking — but must stay visually distinguishable so
   * staff never mistake a generated answer for a colleague's.
   */
  from: "them" | "human" | "ai";
  t: string;
  /** ISO timestamp from the server — drives the thread's day separators. */
  createdAt?: string;
  body: string;
  attach?: string;
  /**
   * Who/what produced an outbound message, e.g. "kewy-ai (shadow)". The shadow
   * suffix means the reply was logged for review and never delivered.
   */
  agent?: string | null;
  metaMessageId?: string | null;
  deliveryStatus?: DeliveryStatus | null;
  deliveryStatusAt?: string | null;
  /** Message row id (present on thread items). */
  id?: string;
  /** SP-31: the customer's latest emoji reaction to this message. */
  reaction?: string | null;
  reactionAt?: string | null;
}

export interface Conversation {
  id: string;
  contactId: string;
  /** Kewy AI is answering this thread. Defaults false; opt-in per conversation. */
  aiEnabled?: boolean;
  /** Set when a human replied into an AI thread — the agent backs off until cleared. */
  aiPausedAt?: string | null;
  unread: number;
  pinned: boolean;
  lastAt: string;
  lastFrom: "them" | "human" | "ai";
  preview: string;
  channel: ConvChannel;
  status: "human" | "pending_customer" | "resolved" | "closed" | "spam";
  assigneeId?: string | null;
  version?: number;
  escalateReason?: string | null;
  statusChangedAt?: string | null;
  labelIds?: string[];
  updatedAt?: string;
  intent: string;
  confidence: number;
  escalated?: boolean;
  /** Conversation resolution (Kewy AI, once the thread went quiet). */
  resolutionStatus?: "resolved" | "closed" | "open" | null;
  resolution?: string | null;
  resolutionIssue?: "complaint" | "escalation" | "none" | null;
  resolutionSummary?: string | null;
  resolvedAt?: string | null;
  /** SP-31: AI topics / pain points from the resolution verdict. */
  topics?: string[] | null;
  painPoints?: string[] | null;
  messages?: Message[];
  // WhatsApp-only: backend populates these when channel === "whatsapp".
  lastInboundAt?: string | null;
  waWindowOpen?: boolean;
  /** SP-19: effective channel (null for l-agent threads) and its provider. */
  channelId?: string | null;
  channelProvider?: string | null;
  /** SP-15: the first ad that started this thread (set once), its time and chip. */
  adSourceId?: string | null;
  adReferredAt?: string | null;
  adSource?: AdSourceChip | null;
}

export type AppointmentStatus =
  | "confirmed"
  | "pending"
  | "completed"
  | "cancelled"
  | "no-show";

export interface Appointment {
  id: string;
  contactId: string;
  staffId?: string;
  service: string;
  serviceAr: string;
  startAt: string;          // ISO 8601
  durationMin: number;
  status: AppointmentStatus;
  source: "human" | "self-booking";
  note?: string;
  noteAr?: string;
  reminderSent?: boolean;
  // Mirror in HJZ (connected workspaces only).
  hjzAppointmentId?: string | null;
  hjzSyncPending?: boolean;
  hjzSyncError?: string | null;
  /** SP-10: catalog links (null for legacy free-text bookings). */
  serviceId?: string | null;
  resourceId?: string | null;
  /** SP-10: optimistic-concurrency counter; send it back on PATCH. */
  version?: number;
  /** SP-10: another open booking of the same staff overlaps this one. */
  conflict?: boolean;
  /** SP-10: the staff schedule check in the workspace timezone. */
  fit?: "ok" | "off_day" | "outside_hours" | "unchecked";
}

// ─── SP-10 bookings catalog ───────────────────────────────────────────────

export type BookingWeekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export interface ScheduleWindow {
  from: string; // "HH:MM"
  to: string; // "HH:MM", 24:00 allowed
}
export type WeeklySchedule = Partial<Record<BookingWeekday, ScheduleWindow[]>>;

/** GET /services row (backend ServiceDto). `price` is a decimal string. */
export interface Service {
  id: string;
  name: string;
  nameAr: string;
  color: StageColor;
  durationMin: number;
  price: string | null;
  currency: string;
  active: boolean;
  archivedAt: string | null;
  order: number;
  version: number;
  staffIds: string[];
  upcomingCount: number;
}

/** GET /staff row (backend StaffResourceDto). */
export interface StaffResource {
  id: string;
  userId: string | null;
  user: { id: string; name: string } | null;
  name: string;
  nameAr: string | null;
  role: string | null;
  color: StageColor;
  schedule: WeeklySchedule;
  scheduleConfigured: boolean;
  active: boolean;
  archivedAt: string | null;
  version: number;
  serviceIds: string[];
  upcomingCount: number;
}

export interface ServiceDeletePreview {
  bookingCount: number;
  upcomingCount: number;
  staffCount: number;
}
export interface StaffDeletePreview {
  bookingCount: number;
  upcomingCount: number;
  serviceCount: number;
}
export type CatalogDeleteResult = { deleted: true } | { archived: true; bookingCount: number };

export interface ProposalServiceData {
  name: string;
  nameAr: string;
  durationMin: number;
  durationDefaulted: boolean;
  price: string | null;
  currency: string | null;
  color?: string;
  description?: string | null;
}
export interface ProposalStaffData {
  name: string;
  nameAr: string | null;
  role: string | null;
  schedule: WeeklySchedule;
  services: string[];
}
export interface ProposalItem {
  key: string;
  kind: "service" | "staff";
  data: ProposalServiceData | ProposalStaffData;
  duplicateOf: { id: string | null; key?: string; name: string } | null;
  selected: boolean;
  error?: { field: string; reason: string };
}

export type CatalogImportStatus = "extracting" | "review" | "running" | "done" | "failed" | "cancelled";

/** GET /catalog-imports/:id (backend CatalogImportDto). */
export interface CatalogImport {
  id: string;
  source: "paste" | "url" | "file";
  kind: "auto" | "services" | "staff";
  status: CatalogImportStatus;
  extractedBy: "template" | "ai" | null;
  fileName: string | null;
  sourceUrl: string | null;
  total: number;
  processed: number;
  created: number;
  skipped: number;
  failed: number;
  errors: { key: string; name: string; reason: string; missing?: string[] }[];
  errorKey: string | null;
  items?: ProposalItem[];
  notes?: { kind: "services" | "staff"; kept: number; dropped: number }[];
  createdAt: string;
  finishedAt: string | null;
}

export interface Campaign {
  id: string;
  name: string;
  /** "paused" only exists on rows from before campaigns could really send. */
  status: "running" | "scheduled" | "draft" | "completed" | "failed" | "cancelled" | "paused" | "launching";
  audience: string;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  conversions: number;
  channel: string;
  schedule: string;
  segmentId: string | null;
  templateId: string | null;
  zernioBroadcastId?: string | null;
  scheduledAt?: string | null;
  launchedAt?: string | null;
  failed?: number;
  skipped?: number;
  lastError?: string | null;
  /** SP-19: the WhatsApp channel it goes out from; null = the default number. */
  senderChannelId?: string | null;
  /** SP-12: true once launch wrote one recipient row per audience member. */
  recipientTracking?: boolean;
  recipientsSyncedAt?: string | null;
  statsSyncedAt?: string | null;
  /** SP-13: the sending numbers in order ([0] = primary); [] = legacy senderChannelId, else the default number. */
  senderChannelIds?: string[];
  /** SP-13: how each {{n}} is filled; null on campaigns from before SP-13 (they keep variableMapping). */
  varMap?: VarMap | null;
  /** SP-13: a library file overriding the template's header sample; null = the template's own file. */
  headerMediaId?: string | null;
  /** SP-13 background launch: planning | sending | done | failed. */
  launchStage?: "planning" | "sending" | "done" | "failed" | null;
  sendTransport?: "broadcast" | "direct" | null;
  /** SP-13 (GET /campaigns and GET /campaigns/:id): cancel has something to stop. Also true for a failed or cancelled launch whose broadcasts may still send. */
  canCancel?: boolean;
  /** SP-13: cancel was asked for while launching; the runner finishes it. */
  cancelRequestedAt?: string | null;
  /** SP-13 (GET /campaigns/:id only): the sending numbers in order; a deleted channel is absent. */
  senders?: CampaignSender[];
  /** SP-13 (GET /campaigns and GET /campaigns/:id): non-null only while status is "launching". */
  launch?: CampaignLaunchProgress | null;
}

// ─── SP-13 campaign sending ───────────────────────────────────────────────

export type VarField = "name" | "firstName" | "lastName" | "phone" | "email";

/** One template placeholder: a contact field, a custom field, or one fixed value. */
export type VarSlot =
  | { source: "field"; key: VarField; fallback?: string }
  | { source: "custom"; key: string; fallback?: string }
  | { source: "static"; value: string };

/** `{"1": slot, "2": slot, …}` (backend sending/var-map.ts). */
export type VarMap = Record<string, VarSlot>;

/** `senders` on GET /campaigns/:id. */
export interface CampaignSender {
  channelId: string;
  displayName: string;
  phoneNumber: string | null;
}

export interface SenderOption extends CampaignSender {
  isDefault: boolean;
  provider: string;
  eligible: boolean;
  reason: null | "provider_meta" | "not_active";
  /** SP-14 (display only): the number's tier from its health snapshot, or "unknown". */
  tier?: string;
  /** SP-14 (display only): the number's quality rating, or "unknown". */
  quality?: string;
  healthCheckedAt?: string | null;
}

/** GET /campaigns/senders */
export interface SendersResponse {
  connected: boolean;
  limit: number;
  senders: SenderOption[];
}

export type TransportKind = "broadcast" | "direct" | "too_varied";

/** POST /campaigns/preview */
export interface CampaignPreviewV2 {
  connected: boolean;
  total: number;
  reachable: number;
  skipped: { noPhone: number; optedOut: number; duplicate: number; missingValue: number };
  missingByKey: { source: "field" | "custom"; key: string; label: string; labelAr: string; count: number }[];
  /** Largest first. */
  split: { channelId: string; displayName: string; phoneNumber: string | null; recipients: number }[];
  transport: { kind: TransportKind; partitions: number; limit: number; directLimit: number };
  /** Channel ids of senders without the approved template. */
  templateMissing: string[];
  /** Channel ids whose templates could not be read. */
  templateCheckFailed?: string[];
  /** SP-14: senders whose copy of the template is paused or disabled. */
  templatePaused?: { channelId: string; status: "paused" | "disabled" | string }[];
  /** Empty without contacts.view (ruling 18). */
  samples: {
    contactId: string;
    name: string | null;
    rendered: string;
    values: string[];
    /** 1-based slot numbers. */
    usedFallback: number[];
    skippedFor: { source: "field" | "custom"; key: string } | null;
  }[];
  estimate: { usd: number; unpriced: number };
}

/** `launch` on GET /campaigns/:id while launching. */
export interface CampaignLaunchProgress {
  stage: "planning" | "sending" | "done" | "failed" | string;
  planned: number;
  partitionsTotal: number;
  partitionsDone: number;
  directSent: number;
}

/** One line of insights.byNumber. */
export interface NumberTotals {
  channelId: string | null;
  displayName: string | null;
  phoneNumber: string | null;
  /** The channel was deleted. */
  unknown: boolean;
  total: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
}

// ─── SP-12 campaign recipients and report ─────────────────────────────────

export type RecipientStatus = "queued" | "sent" | "delivered" | "read" | "replied" | "failed" | "skipped";

export interface CampaignRecipientRow {
  id: string;
  contactId: string | null;
  name: string | null;
  phone: string | null;
  status: RecipientStatus;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  repliedAt: string | null;
  replyText: string | null;
  buttonPayload: string | null;
  replyMessageId: string | null;
  failureCode: string | null;
  failureTitle: string | null;
  channel: { id: string; displayName: string; phoneNumber: string | null } | null;
}

/** GET /campaigns/:id/recipients */
export interface RecipientsPage {
  tracked: boolean;
  items: CampaignRecipientRow[];
  nextCursor: string | null;
}

export interface CampaignFunnel {
  targeted: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
}

export interface ReadTiming {
  withinHour: number;
  oneToSix: number;
  sixToDay: number;
  afterDay: number;
}

/** GET /campaigns/:id/insights */
export interface CampaignInsights {
  tracked: boolean;
  total: number;
  counts: Record<RecipientStatus, number>;
  funnel: CampaignFunnel;
  readTiming: ReadTiming;
  replies: { payload: string | null; label: string | null; count: number }[];
  failures: { code: string; title: string | null; count: number }[];
  unrecorded: number;
  recipientsSyncedAt: string | null;
  statsSyncedAt: string | null;
  /** SP-13: per sending number, largest first; [] for untracked campaigns. */
  byNumber?: NumberTotals[];
}

/** POST /campaigns/:id/follow-up/* */
export interface FollowUpResult {
  added: number;
  already: number;
  leftOut: number;
  groupId?: string;
}

/** Value for one template placeholder in a campaign broadcast. */
export type CampaignVariable =
  | { field: "name" | "phone" }
  | { field: "custom"; customValue: string };

export interface CampaignPreview {
  total: number;
  reachable: number;
  skipped: { noPhone: number; optedOut: number; duplicate: number };
  estimate: { usd: number; unpriced: number };
}

export interface Intent {
  name: string;
  pct: number;
  count: number;
}

export type TemplateButtonType = "QUICK_REPLY" | "URL" | "PHONE_NUMBER";
export interface TemplateButtonDef {
  type: TemplateButtonType;
  text: string;
  url?: string;
  phone_number?: string;
}

export interface Template {
  id: string;
  name: string;
  lang: Lang;
  category: "TRANSACTIONAL" | "UTILITY" | "MARKETING" | "AUTHENTICATION";
  /** SP-14: "paused" and "disabled" are Meta's template states (never sendable). */
  status: "approved" | "pending" | "rejected" | "submitted" | "failed" | "local" | "paused" | "disabled";
  /** SP-14: Meta template quality (GREEN | YELLOW | RED | NOT_RATED); null = unknown. */
  quality?: string | null;
  /** SP-14 final review M5: "zernio_passthrough" when the list just read carried the score. */
  qualitySource?: "zernio_passthrough" | null;
  /** SP-14 final review M5: when the list confirming `quality` was read; null = not read now (a stored, previous value). */
  qualityReadAt?: string | null;
  uses: number;
  body?: string | null;
  footer?: string | null;
  headerType?: string | null;
  headerContent?: string | null;
  /** SP-13: the library file used as the media header's sample. */
  headerMediaId?: string | null;
  // Stored as JSON string on the server; the API hands it back unparsed.
  buttons?: string | null;
}

// ─── Segments ─────────────────────────────────────────────────────────────

export interface SegmentFilter {
  lifecycle?: string[];
  industry?: string[];
  source?: string[];
  tagsAll?: string[];
  tagsAny?: string[];
  search?: string;
  hasPhone?: boolean;
  /** Contact has at least one deal currently in any of these stage keys. */
  stageAny?: string[];
}

/** crm = saved filter (re-evaluated), manual = user-picked membership,
 *  hjz = membership snapshot pushed by the HJZ sync (read-only here). */
export type SegmentOrigin = "crm" | "manual" | "hjz";

// ─── SP-16 smart audience rules (mirror of backend segments/audience-rules.ts) ──

export type RelUnit = "hours" | "days" | "weeks" | "months";
export interface RelTime {
  amount: number;
  unit: RelUnit;
}
export type AudienceFieldOp = "eq" | "contains" | "gt" | "lt" | "set" | "unset";
export type CampaignRuleOp = "received" | "read" | "replied" | "not_replied" | "failed";
export type FollowUpRuleOp = "open" | "overdue" | "none_open";

export type AudienceRule = (
  | { field: "tag"; op: "has" | "not_has"; tag: string }
  | { field: "lifecycle"; op: "in" | "not_in"; values: string[] }
  | { field: "not_a_lead"; op: "is" | "is_not" }
  | { field: "last_active"; op: "within" | "more_than"; value: RelTime }
  | { field: "conversations"; op: "none" | "any" }
  | { field: "channel"; op: "is" | "is_not"; channel: string }
  | { field: "group"; op: "in" | "not_in"; segmentId: string }
  | { field: "created"; op: "within" | "more_than"; value: RelTime }
  | { field: "created"; op: "before" | "after"; date: string }
  | { field: "pipeline_stage"; op: "in" | "not_in"; pipelineId: string; stageId?: string }
  | { field: "custom_field"; op: AudienceFieldOp; defId: string; value?: string }
  | { field: "campaign"; op: CampaignRuleOp; campaignId: string }
  | { field: "follow_up"; op: FollowUpRuleOp }
  | { field: "industry" | "source"; op: "in"; values: string[] }
  | { field: "name"; op: "contains"; value: string }
  | { field: "phone"; op: "set" | "unset" }
  | { field: "stage_key"; op: "in"; keys: string[] }
) & { missing?: true };

export type AudienceField = AudienceRule["field"];
export interface AudienceGroup {
  op: "and" | "or";
  rules: AudienceNode[];
}
export type AudienceNode = AudienceGroup | AudienceRule;
export type AudienceRules = AudienceGroup & { v: 2 };

export type RuleIssueKind =
  | "tag_deleted"
  | "group_missing"
  | "field_missing"
  | "pipeline_missing"
  | "pipeline_archived"
  | "stage_missing"
  | "campaign_missing"
  | "cycle"
  | "too_deep";
/** `path` is the child-index path of the rule in the tree. */
export interface RuleIssue {
  path: number[];
  kind: RuleIssueKind;
}

/** SP-16 `AudienceRow` (backend segments/audience-dto.ts). */
export interface Segment {
  id: string;
  name: string;
  nameAr: string | null;
  color: string | null;
  origin: SegmentOrigin;
  filter: SegmentFilter;
  /** crm: always a tree (a legacy filter converted); manual/hjz: null. */
  rules?: AudienceRules | null;
  rulesSource?: "rules" | "legacy" | null;
  /** null while unknown: the count timed out (`timedOut`) or is not computed yet. Never read it as 0. */
  count: number | null;
  countedAt?: string | null;
  timedOut?: boolean;
  /** Not counted in this request (list deadline or a busy pool): "Not counted yet", not "too large". */
  skipped?: boolean;
  issues?: RuleIssue[];
  version?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AudienceRefAudience {
  id: string;
  name: string;
  nameAr: string | null;
}
export interface AudienceRefCampaign {
  id: string;
  name: string;
  status: string;
}

/** `GET /segments/:id`. */
export interface AudienceDetail extends Segment {
  references: { audiences: AudienceRefAudience[]; campaigns: AudienceRefCampaign[] };
}

export interface AudienceContact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  lifecycle: string;
}

/** `GET /segments/:id/contacts` and `/candidates`: keyset pages. */
export interface AudienceContactsPage {
  items: AudienceContact[];
  nextCursor: string | null;
  timedOut: boolean;
}

/** `POST /segments/preview`. */
export interface AudiencePreview {
  count: number | null;
  timedOut: boolean;
  skipped?: boolean;
  sample: { id: string; name: string; phone: string | null }[];
  issues: RuleIssue[];
}

/** `GET /tags/:id/references`. */
export interface TagReferences {
  audiences: AudienceRefAudience[];
}

// ─── Tags ─────────────────────────────────────────────────────────────────

export interface TagRow {
  id: string;
  name: string;
  color: string;
  usageCount: number;
}

// ─── Notes ────────────────────────────────────────────────────────────────

export interface Note {
  id: string;
  contactId: string;
  conversationId: string | null;
  ticketId: string | null;
  body: string;
  authorUserId: string | null;
  parentId?: string | null;
  mentions?: string[];
  replies?: Note[];
  seenBy?: Array<{ userId: string; seenAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface NoteWarning {
  userId: string;
  reason: "not_a_member" | "no_access";
}

export interface Notification {
  id: string;
  type: string;
  /** Message KEY (e.g. "assignment.ticket"), localized client-side. */
  title: string;
  /** JSON string of message params. */
  body: string | null;
  recordKind: string | null;
  recordId: string | null;
  readAt?: string | null;
  createdAt: string;
  sound?: boolean;
}

export interface NotificationPreference {
  type: string;
  inApp: boolean;
  sound: boolean;
}

// ─── Workspaces ───────────────────────────────────────────────────────────

export type WorkspaceRole = "owner" | "admin" | "agent" | "viewer";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  lang: string;
  plan: string;
  role: WorkspaceRole;
}

// ─── Admin portal (super-admin views) ─────────────────────────────────────

export interface AdminWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  plan: string;
  lang: string;
  timezone: string;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
  owner: { id: string; email: string; name: string } | null;
  counts: {
    members: number;
    contacts: number;
    conversations: number;
    tickets: number;
  };
}

export interface AdminWorkspaceDetail {
  id: string;
  name: string;
  slug: string;
  plan: string;
  lang: string;
  timezone: string;
  suspendedAt: string | null;
  createdAt: string;
  updatedAt: string;
  members: Array<{
    id: string;
    role: WorkspaceRole;
    user: {
      id: string;
      email: string;
      name: string;
      initials: string;
      color: string;
      status: string;
      isSuperAdmin: boolean;
    };
  }>;
  integrations: Array<{
    id: string;
    platform: string;
    pageId: string | null;
    pageName: string | null;
    expiresAt: string | null;
    lastFetchedAt: string | null;
  }>;
  _count: {
    contacts: number;
    conversations: number;
    messages: number;
    tickets: number;
    campaigns: number;
    templates: number;
  };
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  initials: string;
  color: string;
  status: string;
  role: string;
  isSuperAdmin: boolean;
  workspaceCount: number;
  createdAt: string;
}

// ─── Media library ────────────────────────────────────────────────────────

export interface Media {
  id: string;
  workspaceId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storedPath: string;
  width: number | null;
  height: number | null;
  uploadedById: string | null;
  createdAt: string;
  /** SP-17: agent-facing details. Null = not described. */
  title: string | null;
  alt: string | null;
  /** Normalised (trimmed, Latin lowercased, deduped), at most 20. */
  tags: string[];
  useWhen: string | null;
  /** The AI agent may list and send this file (list_photos). Off by default. */
  approvedForAgent: boolean;
}

// ─── Social publishing ────────────────────────────────────────────────────

export type PublishChannel = "facebook" | "instagram" | "tiktok";

export interface ChannelResult {
  ok: boolean;
  postId?: string;
  error?: string;
}

// ─── Workflows ────────────────────────────────────────────────────────────

export type WorkflowTriggerType =
  | "contact_created"
  | "message_received"
  | "ticket_created"
  | "ticket_stage_changed"
  | "schedule"
  | "webhook"
  | "appointment_completed"
  | "sale_completed";

export type WorkflowStatus = "draft" | "active";

export type WorkflowConditionOperator = "equals" | "not_equals" | "contains" | "not_contains";

export interface WorkflowConditionConfig {
  field: string;
  operator: WorkflowConditionOperator;
  value: string;
}

export interface WorkflowAiConditionConfig {
  prompt: string;
}

export interface WorkflowSendWhatsappConfig {
  message: string;
}

/** Approved Meta template; `variables` fill its {{1}}, {{2}}… in order. */
export interface WorkflowSendWhatsappTemplateConfig {
  name: string;
  language: string;
  variables: string[];
}

export interface WorkflowAskAgentConfig {
  prompt: string;
}

export type WorkflowUpdateDataConfig =
  | { operation: "add_tag"; tag: string }
  | { operation: "remove_tag"; tag: string }
  | { operation: "move_ticket_stage"; stageId: string }
  | {
      operation: "update_contact_field";
      field: "name" | "phone" | "industry" | "lifecycle" | "source" | "value";
      value: string;
    };

export interface WorkflowDelayConfig {
  amount: number;
  unit: "minutes" | "hours" | "days";
}

interface WorkflowBaseStep {
  id: string;
  next?: string;
}

export interface WorkflowConditionStep extends WorkflowBaseStep {
  type: "condition";
  config: WorkflowConditionConfig;
  thenNext?: string;
  elseNext?: string;
}

export interface WorkflowAiConditionStep extends WorkflowBaseStep {
  type: "ai_condition";
  config: WorkflowAiConditionConfig;
  thenNext?: string;
  elseNext?: string;
}

export interface WorkflowSendWhatsappStep extends WorkflowBaseStep {
  type: "send_whatsapp";
  config: WorkflowSendWhatsappConfig;
}

export interface WorkflowSendWhatsappTemplateStep extends WorkflowBaseStep {
  type: "send_whatsapp_template";
  config: WorkflowSendWhatsappTemplateConfig;
}

export interface WorkflowAskAgentStep extends WorkflowBaseStep {
  type: "ask_agent";
  config: WorkflowAskAgentConfig;
}

export interface WorkflowUpdateDataStep extends WorkflowBaseStep {
  type: "update_data";
  config: WorkflowUpdateDataConfig;
}

export interface WorkflowDelayStep extends WorkflowBaseStep {
  type: "delay";
  config: WorkflowDelayConfig;
}

export type WorkflowStep =
  | WorkflowConditionStep
  | WorkflowAiConditionStep
  | WorkflowSendWhatsappStep
  | WorkflowSendWhatsappTemplateStep
  | WorkflowAskAgentStep
  | WorkflowUpdateDataStep
  | WorkflowDelayStep;

export type WorkflowStepType = WorkflowStep["type"];

export interface WorkflowStepGraph {
  entry: string | null;
  steps: Record<string, WorkflowStep>;
}

export interface Workflow {
  id: string;
  name: string;
  status: WorkflowStatus;
  triggerType: WorkflowTriggerType;
  triggerConfig: Record<string, unknown>;
  steps: WorkflowStepGraph;
  webhookSecret: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  context: { trigger: Record<string, unknown>; steps: Record<string, unknown> };
  stepsSnapshot: WorkflowStepGraph;
  result: Record<string, unknown>;
  isTest: boolean;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ─── Channels hub (SP-19) ─────────────────────────────────────────────────

export type ChannelStatus = "active" | "pending" | "needs_attention" | "disconnected" | "error";

export type VerificationStage = "needs_number" | "awaiting_code" | "needs_registration";

/** Non-secret channel settings, as whitelisted by the backend's `toChannelDto`. */
export interface ChannelConfig {
  allowedOrigins?: string[];
  greeting?: string | null;
  greetingAr?: string | null;
  color?: string | null;
  position?: "start" | "end";
  askName?: boolean;
  lang?: "en" | "ar" | null;
  wabaId?: string;
  verification?: { stage?: VerificationStage; resendAt?: string; method?: string; verifiedAt?: string } | null;
  botUsername?: string;
}

export interface ChannelDto {
  id: string;
  /** whatsapp | telegram | webchat | facebook | instagram | tiktok, others verbatim. */
  kind: string;
  /** zernio | meta | telegram | native, legacy values verbatim (e.g. kapso). */
  provider: string;
  externalId: string | null;
  displayName: string;
  phoneNumber: string | null;
  status: ChannelStatus | string;
  statusReason: string | null;
  isDefault: boolean;
  config: ChannelConfig | null;
  lastInboundAt: string | null;
  createdAt: string;
  conversationCount?: number;
  /** SP-14: the number's health snapshot (WhatsApp only); null until the first check. */
  health?: ChannelHealthPublic | null;
  /** SP-14: when the last check read something. */
  healthCheckedAt?: string | null;
  /** SP-14: when the next live check is allowed; null when no cooldown is running. */
  healthNextCheckAt?: string | null;
}

// ─── SP-14 number and template health ─────────────────────────────────────

/** Why a health value is "unknown" (null when it is a real value). */
export type HealthSignalError =
  | null
  | "unsupported"
  | "check_failed"
  | "permission_denied"
  | "missing_data"
  | "missing_credentials";

/** One health field. `value` is the provider value, or the sentinel "unknown". */
export interface HealthSignal {
  value: string;
  checkedAt: string | null;
  error: HealthSignalError;
  /** R1: read from a field Zernio passes through from Meta without documenting it. */
  source?: "zernio_passthrough";
}

export type HealthFieldName =
  | "quality"
  | "tier"
  | "nameStatus"
  | "verified"
  | "codeVerification"
  | "messaging"
  | "phoneStatus"
  | "accountReview";

export interface TemplateSummaryPublic {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
  paused: number;
  disabled: number;
  lowQuality: number;
  /** Templates whose quality the provider did not report (absent on snapshots stored before it existed). */
  qualityUnknown?: number;
  truncated: boolean;
}

export interface HealthTemplatesSignal {
  value: TemplateSummaryPublic | "unknown";
  checkedAt: string | null;
  error: HealthSignalError;
}

export type HealthOverall = "healthy" | "attention" | "critical" | "unknown";

/** `ChannelDto.health` (backend `publicHealth`): no alerts, no template items. */
export interface ChannelHealthPublic extends Record<HealthFieldName, HealthSignal> {
  v: 1;
  provider: "zernio" | "meta";
  /** The external account this health was read from (the backend hides another account's health). */
  accountId?: string | null;
  checkedAt: string | null;
  trigger: "manual" | "sweep" | "webhook";
  overall: HealthOverall;
  templates: HealthTemplatesSignal;
  issues: string[];
  /** The previous known value of a field that is unknown now because a read failed. */
  lastKnown: Partial<Record<HealthFieldName, { value: string; checkedAt: string; source?: "zernio_passthrough" }>>;
}

/** One template on one number (Meta status UPPERCASE verbatim). */
export interface NumberTemplateItem {
  id: string | null;
  name: string;
  language: string;
  status: string;
  /** GREEN | YELLOW | RED | NOT_RATED | "unknown" */
  quality: string;
  category: string | null;
  source?: "zernio_passthrough";
}

/** GET /channels/:id/templates */
export interface ChannelTemplatesResponse {
  channelId: string;
  checkedAt: string | null;
  error: HealthSignalError;
  truncated: boolean;
  /** false: no snapshot or an unknown list, so `items` is empty but that is not "no templates". */
  known: boolean;
  items: NumberTemplateItem[];
}

/** GET /templates/:id/health */
export interface TemplateHealthResponse {
  template: { id: string; name: string; lang: string; status: string; quality: string | null; reviewedAt: string | null };
  numbers: {
    channelId: string;
    displayName: string;
    phoneNumber: string | null;
    provider: string;
    isDefault: boolean;
    /** lowercase status, or "missing" / "unknown" */
    status: string;
    quality: string;
    checkedAt: string | null;
  }[];
}

export interface ChannelLimits {
  whatsapp: { used: number; limit: number; plan: string };
  /** Only present for channels.update holders. */
  secretsEncryption?: "on" | "off";
  /** The backend's PUBLIC_BASE_URL origin, for the widget snippet and chat link. */
  publicBaseUrl?: string;
}

export interface EmbeddedSignupConfig {
  enabled: boolean;
  appId?: string;
  configId?: string;
  solutionId?: string;
  graphVersion: string;
  reason?: string;
  /** Env names only, and only for channels.update holders. */
  missing?: string[];
}

// ─── SP-15: ad attribution and Meta Ads ───────────────────────────────────

/** The ad chip on a conversation row (`GET /conversations`). */
export interface AdSourceChip {
  id: string;
  /** Meta's ad id (the label of an ad with no name or headline). */
  sourceId: string;
  sourceType: string;
  headline: string | null;
  adName: string | null;
  mediaType: string | null;
  /** `/api/media/<id>/file` once re-hosted, else Meta's (possibly expired) link, else null. */
  imageUrl: string | null;
}

/** One ad for the inbox filter (`GET /ad-sources`). */
export interface AdSourceOption {
  id: string;
  label: string;
  sourceType: string;
  lastReferredAt: string | null;
}

/** One ad on the Ads tab (`GET /ad-sources/overview`) or its page (`GET /ad-sources/:id`, with `daily`). */
export interface AdCard {
  id: string;
  sourceId: string;
  sourceType: string;
  headline: string | null;
  body: string | null;
  adName: string | null;
  adSetName: string | null;
  campaignName: string | null;
  namesFrom: string | null;
  mediaType: string | null;
  imageUrl: string | null;
  sourceUrl: string | null;
  adAccountId: string | null;
  firstReferredAt: string | null;
  lastReferredAt: string | null;
  /** Conversations started in the range. */
  started: number;
  /** null = Unknown (no active connection, another ad account, or days not synced yet). */
  spend: { amount: number; currency: string } | null;
  /** null when nothing started or spend is unknown. */
  costPerConversation: number | null;
  daily?: { date: string; started: number; spend: number | null }[];
}

export type MetaAdsStatus = "not_connected" | "pending" | "active" | "needs_reconnect" | "disconnected";

export interface MetaAdsConnectionDto {
  status: MetaAdsStatus;
  statusReason: string | null;
  adAccountId: string | null;
  adAccountName: string | null;
  currency: string | null;
  timezone: string | null;
  pageId: string | null;
  pageName: string | null;
  connectedAt: string | null;
  connectedBy: { id: string; name: string } | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  spendBackfilled: boolean;
  tokenExpiresAt: string | null;
  hasPendingLogin: boolean;
  /** `missing` is present only for connectors.manage holders. */
  config: { ready: boolean; missing?: string[] };
}

export interface AdsCurrencyTotal {
  currency: string;
  spend: number;
  started: number;
  costPerConversation: number | null;
}

export interface AdsDailyPoint {
  date: string;
  started: number;
  /** null when no connection is active, or the day is outside the synced days. */
  spend: Record<string, number> | null;
}

export interface AdsOverview {
  /** `spendCoverage`: the account days the spend sync has read (null before the first full sync). */
  range: { from: string; to: string; tz: string; spendCoverage?: { from: string; to: string } | null };
  connection: MetaAdsConnectionDto | null;
  totals: { started: number; byCurrency: AdsCurrencyTotal[] };
  daily: AdsDailyPoint[];
  ads: AdCard[];
  totalAds: number;
  /** Any ad was ever referred (tells "none in this range" from "none yet"). */
  everReferred?: boolean;
}

export interface MetaAdsCandidates {
  adAccounts: { id: string; name: string; currency: string; timezone: string; accountStatus: number | string | null }[];
  pages: { id: string; name: string }[];
  scopes?: string[];
}

export interface AdConversationItem {
  conversationId: string;
  contactId: string;
  contactName: string | null;
  channelId: string | null;
  referredAt: string;
  firstTouch: boolean;
  status: string;
  assigneeId: string | null;
}

// ─── SP-11 insights (mirror of backend/src/insights/insights.dto.ts) ─────────

/** One independently computed block: `unavailable` renders a notice, `forbidden` is hidden. */
export type Section<T> = { status: "ok"; data: T } | { status: "unavailable" } | { status: "forbidden" };

export interface InsightsRange {
  /** First local day, inclusive (`YYYY-MM-DD`). */
  from: string;
  /** Last local day, inclusive. */
  to: string;
  tz: string;
}

export interface SupportHeadline {
  conversations: number;
  decided: number;
  aiResolved: number;
  /** Percent, one decimal; null when nothing was decided. */
  aiResolutionRate: number | null;
  /** Whole seconds; null without samples. */
  medianFirstResponseSec: number | null;
  unanswered: number;
  medianHandlingSec: number | null;
  timeSaved: { customerMessages: number; hours: number };
  ticketShare: number | null;
}

export interface ResolutionMix {
  ai: number;
  human: number;
  escalated: number;
  closed: number;
}

export interface Peaks {
  /** [dayOfWeek 0=Sunday … 6=Saturday][hour 0–23], workspace-local. */
  matrix: number[][];
  byHour: number[];
}

export interface ByNumberRow {
  /** null = "Unassigned number". */
  channelId: string | null;
  label: string;
  conversations: number;
  aiResolutionRate: number | null;
}

export interface TopicFrictionRow {
  topic: string;
  count: number;
  escalatedShare: number;
  negativeShare: number;
}

export interface TeamRow {
  /** null for the "Former member" and "Unattributed" rows (told apart by `former`). */
  userId: string | null;
  name: string;
  former: boolean;
  assigned: number;
  replies: number;
  medianFirstResponseSec: number | null;
  resolved: number;
}

export interface SupportInsights {
  range: InsightsRange;
  channelId: string | null;
  headline: Section<SupportHeadline>;
  resolutionMix: Section<ResolutionMix>;
  peaks: Section<Peaks>;
  byNumber: Section<ByNumberRow[]>;
  topicFriction: Section<TopicFrictionRow[]>;
  team: Section<TeamRow[]>;
  /** Workspace-local day of the start of sender recording (SP-11 migration applied, or workspace creation if later); null = none yet (or unavailable). */
  attributionSince: string | null;
}

export type SpeedBucket = "lt_5m" | "5_15m" | "15_60m" | "1_4h" | "4_24h" | "gt_24h" | "not_replied";

/** Without tickets.view only `id` is present. */
export interface SalesPipelineRef {
  id: string;
  name?: string;
  nameAr?: string;
  kind?: string;
}

export interface SalesRepRow {
  userId: string | null;
  name: string;
  former: boolean;
  leads: number;
  won: number;
  lost: number;
  medianSpeedToReplySec: number | null;
  followUps: { done: number; overdue: number; dueToday: number };
}

export interface SalesInsights {
  range: InsightsRange;
  pipeline: SalesPipelineRef;
  headline: Section<{ leads: number; replied: number; medianSpeedToReplySec: number | null; waiting: number; won: number }>;
  distribution: Section<{ bucket: SpeedBucket | string; count: number }[]>;
  weekly: Section<{ weekStart: string; leads: number; won: number }[]>;
  sources: Section<{ kind: string; key: string; id?: string; label: string; leads: number; won: number }[]>;
  funnel: Section<{ stageId: string; key: string; label: string; labelAr: string; reached: number; isWon: boolean; isTerminal: boolean }[]>;
  lostReasons: Section<{ reasonId: string | null; label: string; labelAr: string; count: number }[]>;
  reps: Section<SalesRepRow[]>;
}

// ─── SP-21 knowledge sources ─────────────────────────────────────────────

export type KnowledgeKind = "content" | "faq" | "guideline" | "file" | "typed_doc" | "website";
export type KnowledgeStatus = "draft" | "queued" | "processing" | "ready" | "failed" | "paused";
export type PageState = "synced" | "needs_login" | "blocked" | "removed" | "error" | "capped";
export type TypedKind = "offers" | "inventory" | "packages";
export type WebsiteSchedule = "daily" | "weekly" | "monthly" | "manual";

/** `GET /knowledge/sources[/:id]`. */
export interface KnowledgeSource {
  id: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  /** An error key (knowledgeErrors.ts), never provider text. */
  error: string | null;
  title: string;
  body?: string | null;
  bodyJson?: unknown;
  question?: string | null;
  order: number;
  typedKind: TypedKind | null;
  url: string | null;
  scope: "site" | "path" | null;
  schedule: WebsiteSchedule | null;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  /**
   * Websites: failed runs in a row (3 → failed). Files and typed docs:
   * transient retries used (0 or 1). Never show website wording for files.
   */
  consecutiveFailures: number;
  lastRun: {
    startedAt?: string;
    finishedAt?: string;
    pagesRead?: number;
    pagesSame?: number;
    pagesChanged?: number;
    pagesNew?: number;
    failed?: boolean;
    reason?: string;
  } | null;
  itemCount: number;
  publishState: "none" | "pending" | "published" | "failed" | string;
  legacy: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  file: { fileName: string; mimeType: string; sizeBytes: number } | null;
  pageCounts?: Partial<Record<PageState, number>>;
}

/** `GET /knowledge/sources/:id/pages`. */
export interface KnowledgePage {
  id: string;
  url: string;
  title: string | null;
  state: PageState;
  httpStatus: number | null;
  lastReadAt: string | null;
  removedAt: string | null;
}

/** `GET /knowledge/sources/:id/preview`: "What your assistant learned". */
export interface KnowledgePreview {
  sourceId: string;
  groups: { heading: string | null; items: { chunkId: string; text: string; rowRef: number | null; url: string | null }[] }[];
  truncated: boolean;
}
