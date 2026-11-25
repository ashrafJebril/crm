// Mirrors backend/src/permissions/catalog.ts. Keep in sync.
export const RESOURCES = [
  "conversations",
  "contacts",
  "tickets",
  "pipelines",
  "bookings",
  "campaigns",
  "templates",
  "audiences",
  "knowledge",
  "agent",
  "channels",
  "connectors",
  "members",
  "roles",
  "billing",
  "settings",
  "api_keys",
  "reports",
  "workflows",
] as const;

export const ACTIONS = ["view", "create", "update", "delete", "manage"] as const;

export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];
export type Permission = `${Resource}.${Action}`;
export type PermissionMatrix = Partial<Record<Resource, Action[]>>;
export type ConversationVisibility = "all" | "assigned";

const ORDER = new Map<string, number>(ACTIONS.map((a, i) => [a, i]));
const sorted = (xs: Action[]): Action[] =>
  [...xs].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));

export function hasPermission(flat: ReadonlySet<string>, p: Permission): boolean {
  return flat.has(p);
}

export function toggleCell(m: PermissionMatrix, r: Resource, a: Action): PermissionMatrix {
  const cur = m[r] ?? [];
  const next = cur.includes(a) ? cur.filter((x) => x !== a) : sorted([...cur, a]);
  return { ...m, [r]: next };
}

export function isRowAll(m: PermissionMatrix, r: Resource): boolean {
  const cur = m[r] ?? [];
  return ACTIONS.every((a) => cur.includes(a));
}

export function isColumnAll(m: PermissionMatrix, a: Action): boolean {
  return RESOURCES.every((r) => (m[r] ?? []).includes(a));
}

export function toggleRow(m: PermissionMatrix, r: Resource): PermissionMatrix {
  return { ...m, [r]: isRowAll(m, r) ? [] : [...ACTIONS] };
}

export function toggleColumn(m: PermissionMatrix, a: Action): PermissionMatrix {
  const all = isColumnAll(m, a);
  const out: PermissionMatrix = { ...m };
  for (const r of RESOURCES) {
    const cur = out[r] ?? [];
    out[r] = all ? cur.filter((x) => x !== a) : cur.includes(a) ? cur : sorted([...cur, a]);
  }
  return out;
}

export const RESOURCE_LABELS: Record<Resource, [string, string]> = {
  conversations: ["Conversations", "المحادثات"],
  contacts: ["Contacts", "جهات الاتصال"],
  tickets: ["Tickets", "التذاكر"],
  pipelines: ["Pipelines", "مسارات المبيعات"],
  bookings: ["Bookings", "الحجوزات"],
  campaigns: ["Campaigns", "الحملات"],
  templates: ["Templates", "القوالب"],
  audiences: ["Audiences", "الشرائح"],
  knowledge: ["Knowledge base", "قاعدة المعرفة"],
  agent: ["AI agent", "الوكيل الذكي"],
  channels: ["Channels", "القنوات"],
  connectors: ["Connectors", "الموصلات"],
  members: ["Members", "الأعضاء"],
  roles: ["Roles", "الأدوار"],
  billing: ["Billing", "الفواتير"],
  settings: ["Settings", "الإعدادات"],
  api_keys: ["API keys", "مفاتيح API"],
  reports: ["Reports", "التقارير"],
  workflows: ["Workflows", "سير العمل"],
};

export const ACTION_LABELS: Record<Action, [string, string]> = {
  view: ["View", "عرض"],
  create: ["Create", "إنشاء"],
  update: ["Update", "تعديل"],
  delete: ["Delete", "حذف"],
  manage: ["Manage", "إدارة"],
};
