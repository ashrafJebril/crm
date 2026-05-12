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
  | "mentions"
  | "keywords"
  | "media"
  | "scheduled"
  | "pipeline"
  | "agents"
  | "campaigns"
  | "contacts"
  | "automations"
  | "analytics"
  | "templates"
  | "team"
  | "billing"
  | "settings"
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

export type ConvChannel = "whatsapp" | "instagram" | "facebook" | "tiktok" | "webchat";

export const CHANNEL_LABEL: Record<ConvChannel, string> = {
  whatsapp:  "WhatsApp",
  instagram: "Instagram",
  facebook:  "Facebook",
  tiktok:    "TikTok",
  webchat:   "Web chat",
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

export interface Agent {
  id: string;
  name: string;
  role: string;
  color: string;
  emoji: string;
  status: "live" | "draft" | "paused";
  convs: number;
  csat: number;
  model: string;
  lang: Lang[];
}

export interface TeamMember {
  id: string;
  name: string;
  role: string;
  initials: string;
  color: string;
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
}

export interface Message {
  from: "them" | "ai" | "human";
  t: string;
  body: string;
  agent?: string;
  attach?: string;
}

export interface Conversation {
  id: string;
  contactId: string;
  agent: string;
  unread: number;
  pinned: boolean;
  lastAt: string;
  lastFrom: "them" | "ai" | "human";
  preview: string;
  channel: ConvChannel;
  status: "ai" | "human" | "closed" | "spam";
  intent: string;
  confidence: number;
  escalated?: boolean;
  messages?: Message[];
  suggested?: string;
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
  agentId?: string;
  staffId?: string;
  service: string;
  serviceAr: string;
  startAt: string;          // ISO 8601
  durationMin: number;
  status: AppointmentStatus;
  source: "ai" | "human" | "self-booking";
  note?: string;
  noteAr?: string;
  reminderSent?: boolean;
}

export interface Campaign {
  id: string;
  name: string;
  status: "running" | "scheduled" | "draft" | "completed" | "paused";
  audience: string;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  conversions: number;
  channel: string;
  schedule: string;
  agent: string;
}

export interface Intent {
  name: string;
  pct: number;
  count: number;
}

export interface Template {
  id: string;
  name: string;
  lang: Lang;
  category: "TRANSACTIONAL" | "UTILITY" | "MARKETING";
  status: "approved" | "pending" | "rejected";
  uses: number;
}

// ─── Notes ────────────────────────────────────────────────────────────────

export interface Note {
  id: string;
  contactId: string;
  conversationId: string | null;
  ticketId: string | null;
  body: string;
  authorUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Social listening: keywords & mentions ────────────────────────────────

export type KeywordKind = "brand" | "hashtag" | "handle" | "competitor";

export interface Keyword {
  id: string;
  value: string;
  kind: KeywordKind;
  enabled: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MentionSource = "google" | "ig-hashtag" | "fb-page" | "news";
export type MentionStatus = "new" | "triaged" | "engaged" | "dismissed";
export type MentionLang = "en" | "ar" | "mixed";
export type MentionDialect = "msa" | "gulf" | "egyptian" | "levantine" | "maghrebi";

export interface Mention {
  id: string;
  keywordId: string;
  source: MentionSource;
  sourceUrl: string | null;
  externalId: string;
  author: string;
  authorHandle: string | null;
  authorReach: number | null;
  body: string;
  lang: MentionLang | null;
  dialect: MentionDialect | null;
  sentiment: number | null;
  topic: string | null;
  postedAt: string | null;
  ingestedAt: string;
  status: MentionStatus;
  keyword?: Keyword;
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
    mentions: number;
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
    mentions: number;
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

export type PublishChannel = "facebook" | "instagram";

export interface ChannelResult {
  ok: boolean;
  postId?: string;
  error?: string;
}

export interface ScheduledPost {
  id: string;
  workspaceId: string;
  content: string;
  mediaIds: string;   // JSON string
  channels: string;   // JSON string
  scheduledFor: string;
  status: "pending" | "publishing" | "published" | "failed" | "canceled";
  attempts: number;
  lastError: string | null;
  results: string;    // JSON string
  publishedAt: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}
