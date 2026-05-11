// Reference data for the Billing screen — plans, invoices, usage meters, add-ons.

export interface Plan {
  id: string;
  name: string;
  price: number | null;
  unit: string;
  convs: string;
  agents: string | number;
  seats: string | number;
  features: string[];
  current?: boolean;
}

export interface Invoice {
  id: string;
  date: string;
  amount: number;
  status: "paid" | "pending" | "failed";
  period: string;
}

export interface UsageMeter {
  label: string;
  used: number;
  limit: number;
  unit: string;
}

export interface AddOn {
  name: string;
  price: number;
  unit: string;
  on: boolean;
}

export const PLANS: Plan[] = [
  {
    id: "starter",
    name: "Starter",
    price: 29,
    unit: "/mo",
    convs: "1,000",
    agents: 1,
    seats: 3,
    features: ["1 WhatsApp number", "Basic AI agent", "CSV import", "Email support"],
  },
  {
    id: "pro",
    name: "Pro",
    price: 149,
    unit: "/mo",
    convs: "10,000",
    agents: 4,
    seats: 10,
    features: [
      "3 WhatsApp numbers",
      "Custom AI personalities",
      "Drip campaigns",
      "Automation builder",
      "Priority support",
    ],
    current: true,
  },
  {
    id: "scale",
    name: "Scale",
    price: 499,
    unit: "/mo",
    convs: "50,000",
    agents: 20,
    seats: 30,
    features: [
      "Unlimited numbers",
      "Multi-tenant routing",
      "SLA 99.95%",
      "SSO + SCIM",
      "Dedicated CSM",
    ],
  },
  {
    id: "ent",
    name: "Enterprise",
    price: null,
    unit: "Custom",
    convs: "Unlimited",
    agents: "—",
    seats: "—",
    features: [
      "Custom volume",
      "On-premise option",
      "Custom AI tuning",
      "24/7 phone support",
      "Audit logs",
    ],
  },
];

export const INVOICES: Invoice[] = [
  { id: "INV-2026-04", date: "May 01, 2026", amount: 149.0, status: "paid", period: "April 2026" },
  { id: "INV-2026-03", date: "Apr 01, 2026", amount: 149.0, status: "paid", period: "March 2026" },
  { id: "INV-2026-02", date: "Mar 01, 2026", amount: 149.0, status: "paid", period: "February 2026" },
  { id: "INV-2026-01", date: "Feb 01, 2026", amount: 149.0, status: "paid", period: "January 2026" },
  { id: "INV-2025-12", date: "Jan 01, 2026", amount: 149.0, status: "paid", period: "December 2025" },
  { id: "INV-2025-11", date: "Dec 01, 2025", amount: 119.0, status: "paid", period: "November 2025" },
];

export const USAGE: UsageMeter[] = [
  { label: "Conversations", used: 6240, limit: 10000, unit: "" },
  { label: "AI tokens", used: 1842000, limit: 5000000, unit: "" },
  { label: "WhatsApp messages", used: 38120, limit: 100000, unit: "" },
  { label: "Team seats", used: 7, limit: 10, unit: "" },
  { label: "Storage", used: 4.2, limit: 25, unit: " GB" },
];

export const ADDONS: AddOn[] = [
  { name: "Extra WhatsApp number", price: 25, unit: "/mo", on: false },
  { name: "Voice agent (beta)", price: 79, unit: "/mo", on: true },
  { name: "Premium support · 4h SLA", price: 199, unit: "/mo", on: true },
  { name: "Custom domain branding", price: 19, unit: "/mo", on: false },
];

export const SPEND_BY_MONTH: number[] = [
  149, 149, 149, 119, 149, 149, 149, 149, 149, 149, 149, 248,
];

export const SPEND_LABELS: string[] = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
