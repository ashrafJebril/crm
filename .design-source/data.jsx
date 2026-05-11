// src/data.jsx — mock data for tkana
// Mix of industries: restaurants, ecommerce, real-estate, clinic, gym

const AGENTS = [
  { id: "luna",   name: "Luna",   role: "Sales & Bookings", color: "150", emoji: "L", status: "live", convs: 184, csat: 94, model: "claude-haiku-4.5", lang: ["en","ar"] },
  { id: "atlas",  name: "Atlas",  role: "Customer Support", color: "240", emoji: "A", status: "live", convs: 312, csat: 88, model: "gpt-4o-mini", lang: ["en"] },
  { id: "nova",   name: "Nova",   role: "Lead Qualifier",   color: "320", emoji: "N", status: "live", convs: 87,  csat: 91, model: "claude-haiku-4.5", lang: ["ar"] },
  { id: "rumi",   name: "Rumi",   role: "Concierge",        color: "60",  emoji: "R", status: "draft", convs: 0,   csat: 0,  model: "claude-haiku-4.5", lang: ["en","ar"] },
];

const TEAM = [
  { id: "u1", name: "Yara Khaled",   role: "Owner",   initials: "YK", color: "150" },
  { id: "u2", name: "Omar Daher",    role: "Manager", initials: "OD", color: "240" },
  { id: "u3", name: "Lina Saad",     role: "Agent",   initials: "LS", color: "320" },
  { id: "u4", name: "Karim Idrissi", role: "Agent",   initials: "KI", color: "60"  },
];

const CONTACTS = [
  { id: "c1", name: "Reem Al-Qahtani",  phone: "+966 50 234 8810", tags: ["VIP","Riyadh"],     industry: "real-estate", lifecycle: "Customer", lastSeen: "2m",  source: "Campaign", convs: 14, value: "SAR 142,000" },
  { id: "c2", name: "James Whitman",    phone: "+1 415 555 0124",  tags: ["Trial"],            industry: "saas",        lifecycle: "Lead",     lastSeen: "1h",  source: "Website",  convs: 3,  value: "—" },
  { id: "c3", name: "Fatima Boutros",   phone: "+961 3 990 145",   tags: ["Repeat"],           industry: "restaurant",  lifecycle: "Customer", lastSeen: "today", source: "QR menu", convs: 22, value: "USD 1,840" },
  { id: "c4", name: "Sven Lindgren",    phone: "+46 70 113 0922",  tags: ["Hot"],              industry: "ecommerce",   lifecycle: "Lead",     lastSeen: "12m", source: "Ads",      convs: 6,  value: "—" },
  { id: "c5", name: "Aisha Rahman",     phone: "+971 50 411 2087", tags: ["VIP","Dubai"],      industry: "clinic",      lifecycle: "Patient",  lastSeen: "3d",  source: "Referral", convs: 9,  value: "AED 6,400" },
  { id: "c6", name: "Marco Bellini",    phone: "+39 333 7 211 044","tags": ["Cold"],           industry: "gym",         lifecycle: "Lead",     lastSeen: "1w",  source: "Walk-in",  convs: 1,  value: "—" },
  { id: "c7", name: "Nadia Ezz",        phone: "+20 100 884 5512", tags: ["Repeat","Cairo"],   industry: "restaurant",  lifecycle: "Customer", lastSeen: "5h",  source: "QR menu",  convs: 18, value: "EGP 3,200" },
  { id: "c8", name: "Hugo Martín",      phone: "+34 600 421 778",  tags: ["VIP"],              industry: "real-estate", lifecycle: "Customer", lastSeen: "yest", source: "Campaign",convs: 11, value: "EUR 24,000" },
  { id: "c9", name: "Priya Venkatesan", phone: "+91 98 1122 3344", tags: ["Hot"],              industry: "ecommerce",   lifecycle: "Lead",     lastSeen: "20m", source: "Website",  convs: 4,  value: "—" },
  { id: "c10",name: "Tariq Ben Salah",  phone: "+212 6 612 099 33","tags": ["Trial"],          industry: "saas",        lifecycle: "Lead",     lastSeen: "8h",  source: "Ads",      convs: 2,  value: "—" },
];

const CONVERSATIONS = [
  {
    id: "k1", contactId: "c1", agent: "luna", unread: 2, pinned: true,
    lastAt: "2m", lastFrom: "them",
    preview: "Could we schedule a viewing for the Olaya tower unit on Saturday?",
    channel: "WhatsApp", status: "ai",
    intent: "Booking", confidence: 0.92,
    messages: [
      { from: "them", t: "10:42", body: "Hi, I saw your listing for the 3-bedroom in Olaya tower." },
      { from: "ai",   t: "10:42", body: "Welcome Reem 👋 — that's unit 18-B, listed at SAR 142k/year. Want me to share photos and the floor plan?", agent: "luna" },
      { from: "them", t: "10:43", body: "Yes please. And do you have a parking spot included?" },
      { from: "ai",   t: "10:43", body: "Two reserved spots, plus a guest spot on the lobby level. Sending the deck now." , agent: "luna" },
      { from: "ai",   t: "10:44", attach: "olaya-tower-deck.pdf", body: "📎 Olaya Tower 18-B · floor plan + 12 photos", agent: "luna" },
      { from: "them", t: "10:51", body: "Beautiful. Could we schedule a viewing for Saturday afternoon?" },
      { from: "ai",   t: "10:51", body: "Absolutely. Saturday I have 2:30, 4:00 and 5:30 PM open. Which works?", agent: "luna" },
      { from: "them", t: "10:52", body: "5:30 works. Two of us." }
    ],
    suggested: "Confirm 5:30 PM, send calendar invite, request ID for building access.",
  },
  {
    id: "k2", contactId: "c3", agent: "atlas", unread: 0, pinned: false,
    lastAt: "8m", lastFrom: "ai",
    preview: "Your order #4892 is on the way — ETA 18 minutes.",
    channel: "WhatsApp", status: "ai",
    intent: "Order status", confidence: 0.99,
  },
  {
    id: "k3", contactId: "c5", agent: "atlas", unread: 1, pinned: false,
    lastAt: "14m", lastFrom: "them",
    preview: "Need to reschedule my Thursday appointment, can I move to next week?",
    channel: "WhatsApp", status: "human",
    intent: "Reschedule", confidence: 0.86, escalated: true,
  },
  {
    id: "k4", contactId: "c4", agent: "nova", unread: 0, pinned: false,
    lastAt: "21m", lastFrom: "ai",
    preview: "Got it — I've added you to our drop notification list for the new collection.",
    channel: "WhatsApp", status: "ai",
    intent: "Subscribe", confidence: 0.95,
  },
  {
    id: "k5", contactId: "c7", agent: "atlas", unread: 0, pinned: false,
    lastAt: "1h", lastFrom: "them",
    preview: "هل التوصيل متاح للمعادي بعد الساعة 11 مساءً؟",
    channel: "WhatsApp", status: "ai",
    intent: "Delivery hours", confidence: 0.78,
  },
  {
    id: "k6", contactId: "c2", agent: "atlas", unread: 0, pinned: false,
    lastAt: "2h", lastFrom: "human",
    preview: "Thanks James — Lina here, I'll get that refunded by EOD.",
    channel: "WhatsApp", status: "human",
    intent: "Refund", confidence: 0.82,
  },
  {
    id: "k7", contactId: "c8", agent: "luna", unread: 3, pinned: false,
    lastAt: "3h", lastFrom: "them",
    preview: "Buenos días, ¿la villa de Marbella sigue disponible?",
    channel: "WhatsApp", status: "ai",
    intent: "Availability", confidence: 0.88,
  },
  {
    id: "k8", contactId: "c9", agent: "nova", unread: 0, pinned: false,
    lastAt: "4h", lastFrom: "ai",
    preview: "Perfect — I've reserved 3 of those in your size and emailed the link.",
    channel: "WhatsApp", status: "closed",
    intent: "Reserve", confidence: 0.94,
  },
  {
    id: "k9", contactId: "c6", agent: "atlas", unread: 0, pinned: false,
    lastAt: "yest", lastFrom: "ai",
    preview: "We've got HIIT Tuesdays at 7pm — should I sign you up?",
    channel: "WhatsApp", status: "ai",
    intent: "Class info", confidence: 0.9,
  },
  {
    id: "k10",contactId: "c10",agent: "atlas",unread: 0, pinned: false,
    lastAt: "yest", lastFrom: "human",
    preview: "Marked as spam — caller asked us to remove their number.",
    channel: "WhatsApp", status: "spam",
    intent: "—", confidence: 0,
  },
];

const CAMPAIGNS = [
  { id: "cm1", name: "Eid Pre-orders 2026",   status: "running",   audience: "VIP · Riyadh", recipients: 1842, sent: 1820, delivered: 1808, read: 1342, replied: 487, conversions: 91, channel: "Broadcast", schedule: "Apr 28, 9:00", agent: "luna" },
  { id: "cm2", name: "Spring drop · waitlist",status: "scheduled", audience: "Trial · Hot",  recipients: 624,  sent: 0,    delivered: 0,    read: 0,    replied: 0,   conversions: 0,  channel: "Drip · 4 steps", schedule: "May 12, 10:00", agent: "nova" },
  { id: "cm3", name: "Clinic reminders",      status: "running",   audience: "Patients · 24h before",recipients: 156, sent: 156, delivered: 154, read: 142, replied: 38, conversions: 134, channel: "Trigger", schedule: "—", agent: "atlas" },
  { id: "cm4", name: "Abandoned cart recovery",status: "running",  audience: "Cart > 24h",  recipients: 412,  sent: 412,  delivered: 408,  read: 312,  replied: 81,  conversions: 47, channel: "Trigger", schedule: "—", agent: "atlas" },
  { id: "cm5", name: "Ramadan menu launch",   status: "draft",     audience: "All customers",recipients: 0,   sent: 0,    delivered: 0,    read: 0,    replied: 0,   conversions: 0,  channel: "Broadcast", schedule: "—", agent: "atlas" },
  { id: "cm6", name: "Q1 NPS survey",         status: "completed", audience: "Repeat · 60d",recipients: 2104, sent: 2104, delivered: 2087, read: 1612, replied: 904, conversions: 0,  channel: "Broadcast", schedule: "Mar 03, 11:00", agent: "atlas" },
];

// 24h hourly volume (synthetic but plausible)
const HOURLY = [4,3,2,1,1,2,3,8,21,38,52,61,68,72,67,70,74,82,69,55,42,31,22,12];

// 7d daily series for analytics
const DAILY = {
  conversations: [184, 212, 248, 276, 261, 309, 342],
  resolved:      [142, 178, 211, 240, 224, 268, 297],
  ai_pct:        [0.74, 0.78, 0.81, 0.79, 0.83, 0.84, 0.86],
  csat:          [88, 89, 91, 90, 92, 91, 93],
  responseTime:  [42, 38, 31, 28, 24, 22, 19], // seconds
};

const INTENTS = [
  { name: "Order status",    pct: 28, count: 384 },
  { name: "Booking / appt",  pct: 19, count: 261 },
  { name: "Pricing",         pct: 14, count: 192 },
  { name: "Refund",          pct: 9,  count: 124 },
  { name: "Reschedule",      pct: 7,  count: 96 },
  { name: "Hours / location",pct: 6,  count: 82 },
  { name: "Other",           pct: 17, count: 233 },
];

const TEMPLATES = [
  { id: "t1", name: "order_confirmed_v2",   lang: "en", category: "TRANSACTIONAL", status: "approved", uses: 4812 },
  { id: "t2", name: "appointment_24h",      lang: "en", category: "UTILITY",       status: "approved", uses: 1304 },
  { id: "t3", name: "abandoned_cart_24h",   lang: "en", category: "MARKETING",     status: "approved", uses: 412 },
  { id: "t4", name: "tahdid_eid_promo",     lang: "ar", category: "MARKETING",     status: "pending",  uses: 0 },
];

Object.assign(window, {
  AGENTS, TEAM, CONTACTS, CONVERSATIONS, CAMPAIGNS, HOURLY, DAILY, INTENTS, TEMPLATES,
});
