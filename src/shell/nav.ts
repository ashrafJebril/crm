import type { ComponentType } from "react";
import type { RouteId } from "@/lib/types";
import {
  IconHome, IconInbox, IconCampaign, IconUsers,
  IconChart, IconTemplate, IconTeam, IconCog, IconCal, IconGlobe,
  IconLayers, IconBolt, IconAttach, IconSparkles,
} from "@/icons";

interface NavItem {
  id: RouteId;
  label: string;
  ar: string;
  Icon: ComponentType<{ w?: number }>;
  badge?: number;
  // When true, hide from non-super-admin users. Kewy operator-only.
  superAdminOnly?: boolean;
}

interface NavSection {
  section: string;
}

export type NavEntry = NavItem | NavSection;
export const isSection = (n: NavEntry): n is NavSection => "section" in n;

export const NAV: NavEntry[] = [
  { section: "Workspace" },
  { id: "dashboard",   label: "Dashboard",   ar: "اللوحة",        Icon: IconHome },
  { id: "inbox",       label: "Inbox",       ar: "الرسائل",       Icon: IconInbox },
  { id: "calendar",    label: "Calendar",    ar: "التقويم",       Icon: IconCal },
  { id: "social",      label: "Social",      ar: "السوشيال",      Icon: IconGlobe },
  { id: "campaigns",   label: "Campaigns",   ar: "الحملات",       Icon: IconCampaign },
  { id: "ads",         label: "Ads Assistant", ar: "مساعد الإعلانات", Icon: IconSparkles },
  { id: "pipeline",    label: "Pipeline",    ar: "خط الأنابيب",   Icon: IconLayers },
  { id: "contacts",    label: "Contacts",    ar: "جهات الاتصال",  Icon: IconUsers },
  { id: "analytics",   label: "Analytics",   ar: "التحليلات",     Icon: IconChart },
  { section: "Manage" },
  { id: "templates",   label: "Templates",   ar: "القوالب",       Icon: IconTemplate },
  { id: "media",       label: "Media",       ar: "الوسائط",        Icon: IconAttach },
  { id: "team",        label: "Team",        ar: "الفريق",        Icon: IconTeam },
  { id: "settings",    label: "Settings",    ar: "الإعدادات",     Icon: IconCog },
  { section: "Kewy ops" },
  { id: "admin",       label: "Admin portal", ar: "بوابة الإدارة",  Icon: IconBolt, superAdminOnly: true },
];

export const TITLES: Record<RouteId, { en: string; ar: string }> = {
  dashboard:   { en: "Dashboard",       ar: "لوحة التحكم" },
  inbox:       { en: "Inbox",           ar: "صندوق الرسائل" },
  calendar:    { en: "Calendar",        ar: "التقويم والحجوزات" },
  social:      { en: "Social media",    ar: "وسائل التواصل" },
  campaigns:   { en: "Campaigns",       ar: "الحملات" },
  ads:         { en: "Ads Assistant",   ar: "مساعد الإعلانات" },
  pipeline:    { en: "Sales pipeline",  ar: "مسار المبيعات" },
  contacts:    { en: "Contacts",        ar: "جهات الاتصال" },
  analytics:   { en: "Analytics",       ar: "التحليلات" },
  templates:   { en: "Templates",       ar: "القوالب" },
  media:       { en: "Media library",   ar: "مكتبة الوسائط" },
  team:        { en: "Team",            ar: "الفريق" },
  settings:    { en: "Settings",        ar: "الإعدادات" },
  admin:       { en: "Kewy admin portal", ar: "بوابة إدارة كيوي" },
};
