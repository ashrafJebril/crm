// Team screen extras: full team member rows (the shared `TeamMember` type
// is intentionally minimal), pending invites, role definitions, the
// permissions matrix, and the activity log.

import type { BadgeKind } from "@/components/Badge";

export type RoleName = "Owner" | "Admin" | "Agent" | "Analyst" | "Viewer";
export type MemberStatus = "online" | "away" | "offline";

export interface TeamMemberFull {
  id: string;
  name: string;
  role: RoleName;
  email: string;
  phone: string;
  status: MemberStatus;
  lastSeen: string;
  joined: string;
  twoFA: boolean;
  initials: string;
  color: string;
  convs: number;
  avgResp: string;
}

export const TEAM_FULL: TeamMemberFull[] = [
  { id: "u1", name: "Yara Khaled",   role: "Owner",   email: "yara@samemha.com",    phone: "+966 50 234 8810",  status: "online",  lastSeen: "now",  joined: "Jan 2024", twoFA: true,  initials: "YK", color: "150", convs: 0,   avgResp: "—" },
  { id: "u2", name: "Omar Daher",    role: "Admin",   email: "omar@samemha.com",    phone: "+966 55 112 0033",  status: "online",  lastSeen: "2m",   joined: "Mar 2024", twoFA: true,  initials: "OD", color: "240", convs: 184, avgResp: "1m 12s" },
  { id: "u3", name: "Lina Saad",     role: "Agent",   email: "lina@samemha.com",    phone: "+961 3 990 145",    status: "online",  lastSeen: "now",  joined: "May 2024", twoFA: true,  initials: "LS", color: "320", convs: 312, avgResp: "0m 48s" },
  { id: "u4", name: "Karim Idrissi", role: "Agent",   email: "karim@samemha.com",   phone: "+212 6 612 099 33", status: "away",    lastSeen: "12m",  joined: "Aug 2024", twoFA: false, initials: "KI", color: "60",  convs: 87,  avgResp: "2m 04s" },
  { id: "u5", name: "Reza Pahlavi",  role: "Analyst", email: "reza@samemha.com",    phone: "+98 21 8866 1102",  status: "offline", lastSeen: "yest", joined: "Oct 2024", twoFA: true,  initials: "RP", color: "30",  convs: 0,   avgResp: "—" },
  { id: "u6", name: "Sofia Almazán", role: "Agent",   email: "sofia@samemha.com",   phone: "+34 600 421 778",   status: "online",  lastSeen: "now",  joined: "Feb 2025", twoFA: true,  initials: "SA", color: "300", convs: 142, avgResp: "1m 02s" },
  { id: "u7", name: "Tomás Reyes",   role: "Viewer",  email: "tomas@partner.io", phone: "+1 415 555 0188",   status: "offline", lastSeen: "3d",   joined: "Mar 2025", twoFA: false, initials: "TR", color: "210", convs: 0,   avgResp: "—" },
];

export interface PendingInvite {
  email: string;
  role: RoleName;
  invitedBy: string;
  sent: string;
}

export const PENDING_INVITES: PendingInvite[] = [
  { email: "fatima@samemha.com",  role: "Agent", invitedBy: "Yara", sent: "2d ago" },
  { email: "newhire@samemha.com", role: "Agent", invitedBy: "Omar", sent: "5h ago" },
];

export interface RoleDef {
  name: RoleName;
  color: BadgeKind;
  descEn: string;
  descAr: string;
}

export const ROLES: RoleDef[] = [
  { name: "Owner",   color: "ai",   descEn: "Full access, billing, delete workspace",          descAr: "صلاحيات كاملة، الفوترة، حذف مساحة العمل" },
  { name: "Admin",   color: "info", descEn: "Manage everything except billing & destruction", descAr: "يدير كل شيء عدا الفوترة والحذف" },
  { name: "Agent",   color: "ok",   descEn: "Reply, assign, manage own conversations",          descAr: "يرد ويوزع ويدير محادثاته" },
  { name: "Analyst", color: "warn", descEn: "Read-only across analytics & reports",             descAr: "قراءة فقط للتحليلات والتقارير" },
  { name: "Viewer",  color: "",     descEn: "Read-only across the workspace",                   descAr: "قراءة فقط لمساحة العمل" },
];

export interface PermArea {
  area: string;
  caps: [string, string, string, string];
}

export const PERMS: PermArea[] = [
  { area: "Inbox",       caps: ["View", "Reply",       "Assign",        "Close"]   },
  { area: "AI Agents",   caps: ["View", "Edit prompt", "Deploy",        "Delete"]  },
  { area: "Campaigns",   caps: ["View", "Create",      "Send",          "Delete"]  },
  { area: "Contacts",    caps: ["View", "Edit",        "Export",        "Delete"]  },
  { area: "Automations", caps: ["View", "Edit",        "Activate",      "Delete"]  },
  { area: "Settings",    caps: ["View", "Edit",        "Integrations",  "Billing"] },
];

export type PermRow = [0 | 1, 0 | 1, 0 | 1, 0 | 1];

export const PERM_MATRIX: Record<RoleName, [PermRow, PermRow, PermRow, PermRow, PermRow, PermRow]> = {
  Owner:   [[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1]],
  Admin:   [[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,1],[1,1,1,0]],
  Agent:   [[1,1,1,1],[1,0,0,0],[1,1,0,0],[1,1,0,0],[1,0,0,0],[1,0,0,0]],
  Analyst: [[1,0,0,0],[1,0,0,0],[1,0,0,0],[1,0,1,0],[1,0,0,0],[1,0,0,0]],
  Viewer:  [[1,0,0,0],[1,0,0,0],[1,0,0,0],[1,0,0,0],[1,0,0,0],[1,0,0,0]],
};

export interface ActivityEntry {
  who: string;
  whatEn: string;
  whatAr: string;
  when: string;
}

export const ACTIVITY: ActivityEntry[] = [
  { who: "Lina",  whatEn: "closed 14 conversations",                   whatAr: "أغلقت ١٤ محادثة",                  when: "12m" },
  { who: "Omar",  whatEn: "approved template tahdid_eid_promo",        whatAr: "اعتمد قالب tahdid_eid_promo",     when: "1h" },
  { who: "Yara",  whatEn: "invited fatima@samemha.com as Agent",          whatAr: "دعت fatima@samemha.com كوكيلة",      when: "2d" },
  { who: "Karim", whatEn: "created automation 'Cart abandon → drip'",  whatAr: "أنشأ أتمتة «سلة مهجورة → تذكير»", when: "2d" },
  { who: "Sofia", whatEn: "exported 1,824 contacts to CSV",            whatAr: "صدّرت ١٬٨٢٤ جهة اتصال إلى CSV",  when: "3d" },
  { who: "Reza",  whatEn: "viewed Q1 NPS report",                       whatAr: "اطلع على تقرير NPS للربع الأول",   when: "4d" },
];
