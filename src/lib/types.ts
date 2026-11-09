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
  /** SP-13: cancel was asked for while launching; the runner finishes it. */
  cancelRequestedAt?: string | null;
  /** SP-13 (GET /campaigns/:id only): the sending numbers in order; a deleted channel is absent. */
  senders?: CampaignSender[];
  /** SP-13 (GET /campaigns/:id only): non-null only while status is "launching". */
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
  status: "approved" | "pending" | "rejected" | "submitted" | "failed" | "local";
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

export interface Segment {
  id: string;
  name: string;
  nameAr: string | null;
  color: string | null;
  origin: SegmentOrigin;
  filter: SegmentFilter;
  count: number;
  createdAt: string;
  updatedAt: string;
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
