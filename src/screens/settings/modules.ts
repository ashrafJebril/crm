import type { Permission } from "@/lib/permissions";

/**
 * SP-11 module settings hub (pure table). Each module lists the places it is
 * configured; a link shows when the member holds its permission (null = any
 * member); a module with no usable link is hidden. `Workspace.enabledModules`
 * is not consulted (ruling 8).
 */
export interface ModuleLink {
  label: string;
  labelAr: string;
  href: string;
  permission: Permission | null;
}

export interface ModuleDef {
  key: string;
  title: string;
  titleAr: string;
  description: string;
  descriptionAr: string;
  links: ModuleLink[];
}

/** The hash that opens the notification preferences dialog (SP-05). */
export const NOTIFICATION_PREFS_HASH = "#/settings?tab=modules&notifPrefs=1";

export const MODULES: ModuleDef[] = [
  {
    key: "inbox",
    title: "Inbox",
    titleAr: "صندوق الوارد",
    description: "Saved replies and conversation labels.",
    descriptionAr: "الردود المحفوظة ووسوم المحادثات.",
    links: [
      { label: "Saved replies", labelAr: "الردود المحفوظة", href: "#/settings?tab=savedReplies", permission: "conversations.manage" },
      { label: "Labels", labelAr: "الوسوم", href: "#/inbox", permission: "conversations.update" },
    ],
  },
  {
    key: "contacts",
    title: "Contacts",
    titleAr: "جهات الاتصال",
    description: "Custom fields and contact import.",
    descriptionAr: "الحقول المخصصة واستيراد جهات الاتصال.",
    links: [
      { label: "Custom fields", labelAr: "الحقول المخصصة", href: "#/contacts?ct=fields", permission: "settings.manage" },
      { label: "Import contacts", labelAr: "استيراد جهات الاتصال", href: "#/contacts", permission: "contacts.create" },
    ],
  },
  {
    key: "pipelines",
    title: "Sales pipelines",
    titleAr: "مسارات المبيعات",
    description: "Stages, the leads pipeline and lost reasons.",
    descriptionAr: "المراحل ومسار العملاء المحتملين وأسباب الخسارة.",
    links: [
      { label: "Pipelines", labelAr: "المسارات", href: "#/settings?tab=pipelines", permission: "pipelines.manage" },
      { label: "Lost reasons", labelAr: "أسباب الخسارة", href: "#/settings?tab=pipelines", permission: "pipelines.manage" },
    ],
  },
  {
    key: "support",
    title: "Support",
    titleAr: "الدعم",
    description: "The support pipeline and its response targets (SLA).",
    descriptionAr: "مسار الدعم وأهداف وقت الاستجابة.",
    links: [{ label: "Support pipeline and SLA", labelAr: "مسار الدعم وأهداف الاستجابة", href: "#/settings?tab=pipelines", permission: "pipelines.manage" }],
  },
  {
    key: "bookings",
    title: "Bookings",
    titleAr: "الحجوزات",
    description: "Services and the staff who deliver them.",
    descriptionAr: "الخدمات والموظفون الذين يقدمونها.",
    links: [
      { label: "Services", labelAr: "الخدمات", href: "#/calendar?tab=services", permission: "bookings.manage" },
      { label: "Staff", labelAr: "الموظفون", href: "#/calendar?tab=staff", permission: "bookings.manage" },
    ],
  },
  {
    key: "campaigns",
    title: "Campaigns and templates",
    titleAr: "الحملات والقوالب",
    description: "Broadcasts and WhatsApp message templates.",
    descriptionAr: "الحملات وقوالب رسائل واتساب.",
    links: [
      { label: "Campaigns", labelAr: "الحملات", href: "#/campaigns", permission: "campaigns.create" },
      { label: "Templates", labelAr: "القوالب", href: "#/templates", permission: "templates.create" },
    ],
  },
  {
    key: "ads",
    title: "Ads",
    titleAr: "الإعلانات",
    description: "The Meta Ads connection.",
    descriptionAr: "ربط إعلانات ميتا.",
    links: [{ label: "Meta Ads connection", labelAr: "ربط إعلانات ميتا", href: "#/ads?tab=connection", permission: "connectors.manage" }],
  },
  {
    key: "agent",
    title: "AI agent",
    titleAr: "وكيل الذكاء الاصطناعي",
    description: "Kewy AI and what it knows.",
    descriptionAr: "Kewy AI وما يعرفه.",
    links: [
      { label: "Kewy AI", labelAr: "Kewy AI", href: "#/agent", permission: "agent.update" },
      { label: "Knowledge", labelAr: "المعرفة", href: "#/settings?tab=aiKnowledge", permission: "knowledge.create" },
    ],
  },
  {
    key: "channels",
    title: "Channels",
    titleAr: "القنوات",
    description: "WhatsApp numbers, Instagram, Messenger and web chat.",
    descriptionAr: "أرقام واتساب وإنستغرام وماسنجر ومحادثة الموقع.",
    links: [{ label: "Channels", labelAr: "القنوات", href: "#/channels", permission: "channels.create" }],
  },
  {
    key: "team",
    title: "Team and roles",
    titleAr: "الفريق والأدوار",
    description: "Invite members and set what each role may do.",
    descriptionAr: "دعوة الأعضاء وتحديد صلاحيات كل دور.",
    links: [
      { label: "Members", labelAr: "الأعضاء", href: "#/settings?tab=members", permission: "members.create" },
      { label: "Roles", labelAr: "الأدوار", href: "#/settings?tab=members", permission: "roles.create" },
    ],
  },
  {
    key: "notifications",
    title: "Notifications",
    titleAr: "الإشعارات",
    description: "What you are notified about, and how.",
    descriptionAr: "ما تُبلَّغ به وكيف.",
    links: [{ label: "Notification preferences", labelAr: "تفضيلات الإشعارات", href: NOTIFICATION_PREFS_HASH, permission: null }],
  },
];

/** The modules this member can configure, each with only its usable links. */
export function visibleModules(can: (p: Permission) => boolean, modules: ModuleDef[] = MODULES): ModuleDef[] {
  return modules
    .map((m) => ({ ...m, links: m.links.filter((l) => l.permission === null || can(l.permission)) }))
    .filter((m) => m.links.length > 0);
}
