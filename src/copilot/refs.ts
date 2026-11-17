/**
 * SP-18 `@` references (pure): results of the already-gated pickers
 * (`GET /search` for customers and tickets, `GET /appointments/search` for
 * bookings) → candidates; at most MAX_REFS per message, no duplicates.
 * The server re-reads every reference as the member (403 when not allowed).
 */
import type { CopilotRef, CopilotRefKind } from "@/lib/types";
import { MAX_REFS } from "./copilotConstants";

export interface RefCandidate {
  kind: CopilotRefKind;
  id: string;
  title: string;
  subtitle?: string;
}

export interface SearchHits {
  contacts?: { id: string; name: string; phone?: string | null }[];
  tickets?: { id: string; number: number; title: string; stageLabel?: string | null }[];
}
export interface BookingHit {
  id: string;
  startAt: string;
  contactName: string | null;
  service: string;
  serviceAr?: string;
}

const key = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;

export function refCandidates(search: SearchHits | null | undefined, bookings: BookingHit[] | null | undefined, selected: CopilotRef[], lang: "en" | "ar" = "en"): RefCandidate[] {
  const taken = new Set(selected.map(key));
  const out: RefCandidate[] = [];
  const add = (c: RefCandidate) => {
    if (taken.has(key(c))) return;
    taken.add(key(c));
    out.push(c);
  };
  for (const c of search?.contacts ?? []) add({ kind: "contact", id: c.id, title: c.name, ...(c.phone ? { subtitle: c.phone } : {}) });
  for (const t of search?.tickets ?? []) add({ kind: "ticket", id: t.id, title: `#${t.number} · ${t.title}`, ...(t.stageLabel ? { subtitle: t.stageLabel } : {}) });
  for (const b of bookings ?? []) {
    const service = lang === "ar" && b.serviceAr ? b.serviceAr : b.service;
    add({ kind: "booking", id: b.id, title: b.contactName ? `${service} · ${b.contactName}` : service, subtitle: b.startAt.slice(0, 16).replace("T", " ") });
  }
  return out;
}

/** Add a reference: unchanged when it is already there or the message has MAX_REFS. */
export function addRef(selected: CopilotRef[], r: CopilotRef): CopilotRef[] {
  if (selected.length >= MAX_REFS || selected.some((s) => key(s) === key(r))) return selected;
  return [...selected, r];
}

export function removeRef(selected: CopilotRef[], r: { kind: string; id: string }): CopilotRef[] {
  return selected.filter((s) => key(s) !== key(r));
}

/** The body's `references`: kind and id only (titles are display-only). */
export const refsForBody = (selected: CopilotRef[]) => selected.slice(0, MAX_REFS).map(({ kind, id }) => ({ kind, id }));
