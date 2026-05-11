// Reference data for the Settings screen — API keys, webhooks, notification matrix,
// WhatsApp numbers, sessions.

export interface ApiKey {
  name: string;
  key: string;
  created: string;
  lastUsed: string;
  perms: "Read+Write" | "Read only";
}

export type WebhookStatus = "active" | "paused" | "failing";

export interface Webhook {
  url: string;
  events: number;
  status: WebhookStatus;
  lastDelivery: string;
  success: number;
}

export interface NotificationPref {
  area: string;
  email: boolean;
  sms: boolean;
  push: boolean;
  inApp: boolean;
}

export interface WhatsAppNumber {
  number: string;
  label: string;
  quality: "GREEN" | "YELLOW" | "RED";
  verified: boolean;
  msgsToday: number;
  agent: string;
}

export interface Session {
  device: string;
  loc: string;
  current: boolean;
  last: string;
}

export const API_KEYS: ApiKey[] = [
  {
    name: "Production",
    key: "tk_live_82a4...c91d",
    created: "Jan 14, 2026",
    lastUsed: "2m ago",
    perms: "Read+Write",
  },
  {
    name: "Staging",
    key: "tk_test_4f12...a7e8",
    created: "Mar 03, 2026",
    lastUsed: "4h ago",
    perms: "Read+Write",
  },
  {
    name: "BI ingest",
    key: "tk_live_91bd...0f44",
    created: "Apr 21, 2026",
    lastUsed: "yesterday",
    perms: "Read only",
  },
];

export const WEBHOOKS: Webhook[] = [
  {
    url: "https://api.samemha.com/hooks/whatsapp",
    events: 12,
    status: "active",
    lastDelivery: "1m ago",
    success: 99.8,
  },
  {
    url: "https://crm.partner.io/v2/tkana",
    events: 7,
    status: "active",
    lastDelivery: "8m ago",
    success: 99.2,
  },
  {
    url: "https://staging.samemha.com/webhook-test",
    events: 3,
    status: "paused",
    lastDelivery: "2d ago",
    success: 87.5,
  },
  {
    url: "https://logs.samemha.com/ingest/conversations",
    events: 5,
    status: "failing",
    lastDelivery: "12m ago",
    success: 64.0,
  },
];

export const NOTIF_PREFS: NotificationPref[] = [
  { area: "New conversation", email: false, sms: false, push: true, inApp: true },
  { area: "Escalated to human", email: true, sms: true, push: true, inApp: true },
  { area: "AI confidence < 0.6", email: false, sms: false, push: true, inApp: true },
  { area: "Campaign completed", email: true, sms: false, push: false, inApp: true },
  { area: "Billing & usage alerts", email: true, sms: false, push: false, inApp: true },
  { area: "Weekly digest", email: true, sms: false, push: false, inApp: false },
];

export const WHATSAPP_NUMBERS: WhatsAppNumber[] = [
  {
    number: "+966 11 234 5678",
    label: "Samemha Amman",
    quality: "GREEN",
    verified: true,
    msgsToday: 1842,
    agent: "Luna",
  },
  {
    number: "+961 1 887 990",
    label: "Samemha Riyadh",
    quality: "GREEN",
    verified: true,
    msgsToday: 412,
    agent: "Atlas",
  },
  {
    number: "+971 4 224 1100",
    label: "Samemha Dubai",
    quality: "YELLOW",
    verified: false,
    msgsToday: 124,
    agent: "Nova",
  },
];

export const SESSIONS: Session[] = [
  { device: "MacBook Pro · Chrome 124", loc: "Riyadh, SA", current: true, last: "now" },
  { device: "iPhone 15 · iOS Safari", loc: "Riyadh, SA", current: false, last: "2h" },
  { device: "iPad · WhatsApp", loc: "Dubai, AE", current: false, last: "yesterday" },
];

export const BRAND_COLORS: string[] = [
  "oklch(0.78 0.18 152)",
  "oklch(0.62 0.18 250)",
  "oklch(0.75 0.16 80)",
  "oklch(0.65 0.20 330)",
  "oklch(0.55 0.22 30)",
];
