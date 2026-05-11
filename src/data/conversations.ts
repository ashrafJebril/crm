import type { Conversation } from "@/lib/types";

export const CONVERSATIONS: Conversation[] = [
  {
    id: "k1", contactId: "c1", agent: "luna", unread: 2, pinned: true,
    lastAt: "2m", lastFrom: "them",
    preview: "Could we schedule a viewing for the Olaya tower unit on Saturday?",
    channel: "whatsapp", status: "ai",
    intent: "Booking", confidence: 0.92,
    messages: [
      { from: "them", t: "10:42", body: "Hi, I saw your listing for the 3-bedroom in Olaya tower." },
      { from: "ai",   t: "10:42", body: "Welcome Reem 👋 — that's unit 18-B, listed at SAR 142k/year. Want me to share photos and the floor plan?", agent: "luna" },
      { from: "them", t: "10:43", body: "Yes please. And do you have a parking spot included?" },
      { from: "ai",   t: "10:43", body: "Two reserved spots, plus a guest spot on the lobby level. Sending the deck now.", agent: "luna" },
      { from: "ai",   t: "10:44", attach: "olaya-tower-deck.pdf", body: "📎 Olaya Tower 18-B · floor plan + 12 photos", agent: "luna" },
      { from: "them", t: "10:51", body: "Beautiful. Could we schedule a viewing for Saturday afternoon?" },
      { from: "ai",   t: "10:51", body: "Absolutely. Saturday I have 2:30, 4:00 and 5:30 PM open. Which works?", agent: "luna" },
      { from: "them", t: "10:52", body: "5:30 works. Two of us." },
    ],
    suggested: "Confirm 5:30 PM, send calendar invite, request ID for building access.",
  },
  { id: "k2", contactId: "c3", agent: "atlas", unread: 0, pinned: false, lastAt: "8m",  lastFrom: "ai",    preview: "Your order #4892 is on the way — ETA 18 minutes.",                              channel: "whatsapp",  status: "ai",     intent: "Order status",   confidence: 0.99 },
  { id: "k3", contactId: "c5", agent: "atlas", unread: 1, pinned: false, lastAt: "14m", lastFrom: "them",  preview: "Need to reschedule my Thursday appointment, can I move to next week?",         channel: "whatsapp",  status: "human",  intent: "Reschedule",     confidence: 0.86, escalated: true },
  { id: "k4", contactId: "c4", agent: "nova",  unread: 0, pinned: false, lastAt: "21m", lastFrom: "ai",    preview: "Got it — I've added you to our drop notification list for the new collection.", channel: "instagram", status: "ai",     intent: "Subscribe",      confidence: 0.95 },
  { id: "k5", contactId: "c7", agent: "atlas", unread: 0, pinned: false, lastAt: "1h",  lastFrom: "them",  preview: "هل التوصيل متاح للمعادي بعد الساعة 11 مساءً؟",                                  channel: "whatsapp",  status: "ai",     intent: "Delivery hours", confidence: 0.78 },
  { id: "k6", contactId: "c2", agent: "atlas", unread: 0, pinned: false, lastAt: "2h",  lastFrom: "human", preview: "Thanks James — Lina here, I'll get that refunded by EOD.",                      channel: "webchat",   status: "human",  intent: "Refund",         confidence: 0.82 },
  { id: "k7", contactId: "c8", agent: "luna",  unread: 3, pinned: false, lastAt: "3h",  lastFrom: "them",  preview: "Buenos días, ¿la villa de Marbella sigue disponible?",                          channel: "instagram", status: "ai",     intent: "Availability",   confidence: 0.88 },
  { id: "k8", contactId: "c9", agent: "nova",  unread: 0, pinned: false, lastAt: "4h",  lastFrom: "ai",    preview: "Perfect — I've reserved 3 of those in your size and emailed the link.",         channel: "facebook",  status: "closed", intent: "Reserve",        confidence: 0.94 },
  { id: "k9", contactId: "c6", agent: "atlas", unread: 0, pinned: false, lastAt: "yest",lastFrom: "ai",    preview: "We've got HIIT Tuesdays at 7pm — should I sign you up?",                        channel: "facebook",  status: "ai",     intent: "Class info",     confidence: 0.9 },
  { id: "k10",contactId: "c10",agent: "atlas", unread: 0, pinned: false, lastAt: "yest",lastFrom: "human", preview: "Marked as spam — caller asked us to remove their number.",                      channel: "whatsapp",  status: "spam",   intent: "—",              confidence: 0 },
  { id: "k11",contactId: "c4", agent: "nova",  unread: 1, pinned: false, lastAt: "32m", lastFrom: "them",  preview: "Saw your IG ad — do these come in size 42?",                                    channel: "instagram", status: "ai",     intent: "Pricing",        confidence: 0.81 },
  { id: "k12",contactId: "c2", agent: "atlas", unread: 0, pinned: false, lastAt: "55m", lastFrom: "ai",    preview: "Welcome! I'm Atlas. What can I help you with today?",                            channel: "webchat",   status: "ai",     intent: "Greeting",       confidence: 0.99 },
];
