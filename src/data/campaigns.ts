import type { Campaign } from "@/lib/types";

export const CAMPAIGNS: Campaign[] = [
  { id: "cm1", name: "Eid Pre-orders 2026",     status: "running",   audience: "VIP · Riyadh",          recipients: 1842, sent: 1820, delivered: 1808, read: 1342, replied: 487, conversions: 91,  channel: "Broadcast",       schedule: "Apr 28, 9:00",  segmentId: null, templateId: null },
  { id: "cm2", name: "Spring drop · waitlist",  status: "scheduled", audience: "Trial · Hot",           recipients: 624,  sent: 0,    delivered: 0,    read: 0,    replied: 0,   conversions: 0,   channel: "Drip · 4 steps",  schedule: "May 12, 10:00", segmentId: null, templateId: null },
  { id: "cm3", name: "Clinic reminders",        status: "running",   audience: "Patients · 24h before", recipients: 156,  sent: 156,  delivered: 154,  read: 142,  replied: 38,  conversions: 134, channel: "Trigger",         schedule: "—",             segmentId: null, templateId: null },
  { id: "cm4", name: "Abandoned cart recovery", status: "running",   audience: "Cart > 24h",            recipients: 412,  sent: 412,  delivered: 408,  read: 312,  replied: 81,  conversions: 47,  channel: "Trigger",         schedule: "—",             segmentId: null, templateId: null },
  { id: "cm5", name: "Ramadan menu launch",     status: "draft",     audience: "All customers",         recipients: 0,    sent: 0,    delivered: 0,    read: 0,    replied: 0,   conversions: 0,   channel: "Broadcast",       schedule: "—",             segmentId: null, templateId: null },
  { id: "cm6", name: "Q1 NPS survey",           status: "completed", audience: "Repeat · 60d",          recipients: 2104, sent: 2104, delivered: 2087, read: 1612, replied: 904, conversions: 0,   channel: "Broadcast",       schedule: "Mar 03, 11:00", segmentId: null, templateId: null },
];
