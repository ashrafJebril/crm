import type { ComponentType } from "react";
import type { RouteId } from "@/lib/types";
import {
  IconHome, IconInbox, IconBot, IconCampaign, IconUsers, IconFlow,
  IconChart, IconTemplate, IconTeam, IconBilling, IconCog, IconCal, IconGlobe,
  IconLayers,
} from "@/icons";

interface NavItem {
  id: RouteId;
  label: string;
  ar: string;
  Icon: ComponentType<{ w?: number }>;
  badge?: number;
  ai?: boolean;
}

interface NavSection {
  section: string;
}

export type NavEntry = NavItem | NavSection;
export const isSection = (n: NavEntry): n is NavSection => "section" in n;

export const NAV: NavEntry[] = [
  { section: "Workspace" },
  { id: "dashboard",   label: "Dashboard",   ar: "اللوحة",        Icon: IconHome },
  { id: "inbox",       label: "Inbox",       ar: "الرسائل",       Icon: IconInbox, badge: 12 },
  { id: "calendar",    label: "Calendar",    ar: "التقويم",       Icon: IconCal },
  { id: "social",      label: "Social",      ar: "السوشيال",      Icon: IconGlobe },
  { id: "agents",      label: "AI Agents",   ar: "الوكلاء",       Icon: IconBot, ai: true },
  { id: "campaigns",   label: "Campaigns",   ar: "الحملات",       Icon: IconCampaign },
  { id: "pipeline",    label: "Pipeline",    ar: "خط الأنابيب",   Icon: IconLayers },
  { id: "contacts",    label: "Contacts",    ar: "جهات الاتصال",  Icon: IconUsers },
  { id: "automations", label: "Automations", ar: "الأتمتة",       Icon: IconFlow },
  { id: "analytics",   label: "Analytics",   ar: "التحليلات",     Icon: IconChart },
  { section: "Manage" },
  { id: "templates",   label: "Templates",   ar: "القوالب",       Icon: IconTemplate },
  { id: "team",        label: "Team",        ar: "الفريق",        Icon: IconTeam },
  { id: "billing",     label: "Billing",     ar: "الفواتير",      Icon: IconBilling },
  { id: "settings",    label: "Settings",    ar: "الإعدادات",     Icon: IconCog },
];

export const TITLES: Record<RouteId, { en: string; ar: string }> = {
  dashboard:   { en: "Dashboard",       ar: "لوحة التحكم" },
  inbox:       { en: "Inbox",           ar: "صندوق الرسائل" },
  calendar:    { en: "Calendar",        ar: "التقويم والحجوزات" },
  social:      { en: "Social media",    ar: "وسائل التواصل" },
  agents:      { en: "AI Agents",       ar: "وكلاء الذكاء الاصطناعي" },
  campaigns:   { en: "Campaigns",       ar: "الحملات" },
  pipeline:    { en: "Sales pipeline",  ar: "مسار المبيعات" },
  contacts:    { en: "Contacts",        ar: "جهات الاتصال" },
  automations: { en: "Automations",     ar: "سير العمل التلقائي" },
  analytics:   { en: "Analytics",       ar: "التحليلات" },
  templates:   { en: "Templates",       ar: "القوالب" },
  team:        { en: "Team",            ar: "الفريق" },
  billing:     { en: "Billing",         ar: "الفواتير" },
  settings:    { en: "Settings",        ar: "الإعدادات" },
};
