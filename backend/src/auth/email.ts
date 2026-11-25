/**
 * One rule for account emails (SP-20 live verification F2): an email is
 * stored trimmed and lowercased, and every lookup by email is
 * case-insensitive, so `X-Owner@Example.com` and `x-owner@example.com` are
 * one account. Rows stored before this rule with other letter case are not
 * rewritten; the insensitive lookups keep them working.
 */
import type { Prisma } from "@prisma/client";

export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/** `where` for users (or invitations) with this email, in any letter case. */
export function emailWhere(raw: unknown): { email: Prisma.StringFilter } {
  return { email: { equals: normalizeEmail(raw), mode: "insensitive" } };
}

/**
 * The row for an email among case-insensitive matches: the exact (normalised)
 * one when there is one, else the oldest-listed. Two legacy rows that differ
 * only by case are possible; the normalised one wins.
 */
export function pickByEmail<T extends { email: string }>(rows: T[], raw: unknown): T | null {
  const email = normalizeEmail(raw);
  return rows.find((r) => r.email === email) ?? rows.find((r) => r.email.toLowerCase() === email) ?? null;
}
