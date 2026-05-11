import type { Agent } from "@/lib/types";

export const AGENTS: Agent[] = [
  {
    id: "luna", name: "Luna", role: "Sales & Bookings", color: "150", emoji: "L",
    status: "live", convs: 184, csat: 94, model: "claude-haiku-4.5", lang: ["en", "ar"],
  },
  {
    id: "atlas", name: "Atlas", role: "Customer Support", color: "240", emoji: "A",
    status: "live", convs: 312, csat: 88, model: "gpt-4o-mini", lang: ["en"],
  },
  {
    id: "nova", name: "Nova", role: "Lead Qualifier", color: "320", emoji: "N",
    status: "live", convs: 87, csat: 91, model: "claude-haiku-4.5", lang: ["ar"],
  },
  {
    id: "rumi", name: "Rumi", role: "Concierge", color: "60", emoji: "R",
    status: "draft", convs: 0, csat: 0, model: "claude-haiku-4.5", lang: ["en", "ar"],
  },
];

export const findAgent = (id?: string) => AGENTS.find((a) => a.id === id || a.name === id);
