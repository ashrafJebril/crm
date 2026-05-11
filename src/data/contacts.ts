import type { Contact } from "@/lib/types";

export const CONTACTS: Contact[] = [
  { id: "c1", name: "Reem Al-Qahtani",  phone: "+966 50 234 8810", tags: ["VIP", "Riyadh"],   industry: "real-estate", lifecycle: "Customer", lastSeen: "2m",   source: "Campaign", convs: 14, value: "SAR 142,000" },
  { id: "c2", name: "James Whitman",    phone: "+1 415 555 0124",  tags: ["Trial"],           industry: "saas",        lifecycle: "Lead",     lastSeen: "1h",   source: "Website",  convs: 3,  value: "—" },
  { id: "c3", name: "Fatima Boutros",   phone: "+961 3 990 145",   tags: ["Repeat"],          industry: "restaurant",  lifecycle: "Customer", lastSeen: "today",source: "QR menu",  convs: 22, value: "USD 1,840" },
  { id: "c4", name: "Sven Lindgren",    phone: "+46 70 113 0922",  tags: ["Hot"],             industry: "ecommerce",   lifecycle: "Lead",     lastSeen: "12m",  source: "Ads",      convs: 6,  value: "—" },
  { id: "c5", name: "Aisha Rahman",     phone: "+971 50 411 2087", tags: ["VIP", "Dubai"],    industry: "clinic",      lifecycle: "Patient",  lastSeen: "3d",   source: "Referral", convs: 9,  value: "AED 6,400" },
  { id: "c6", name: "Marco Bellini",    phone: "+39 333 7 211 044",tags: ["Cold"],            industry: "gym",         lifecycle: "Lead",     lastSeen: "1w",   source: "Walk-in",  convs: 1,  value: "—" },
  { id: "c7", name: "Nadia Ezz",        phone: "+20 100 884 5512", tags: ["Repeat", "Cairo"], industry: "restaurant",  lifecycle: "Customer", lastSeen: "5h",   source: "QR menu",  convs: 18, value: "EGP 3,200" },
  { id: "c8", name: "Hugo Martín",      phone: "+34 600 421 778",  tags: ["VIP"],             industry: "real-estate", lifecycle: "Customer", lastSeen: "yest", source: "Campaign", convs: 11, value: "EUR 24,000" },
  { id: "c9", name: "Priya Venkatesan", phone: "+91 98 1122 3344", tags: ["Hot"],             industry: "ecommerce",   lifecycle: "Lead",     lastSeen: "20m",  source: "Website",  convs: 4,  value: "—" },
  { id: "c10",name: "Tariq Ben Salah",  phone: "+212 6 612 099 33",tags: ["Trial"],           industry: "saas",        lifecycle: "Lead",     lastSeen: "8h",   source: "Ads",      convs: 2,  value: "—" },
];

export const findContact = (id: string) => CONTACTS.find((c) => c.id === id);
