import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeTx } from "@/lib/tx";
import { ApiError } from "@/api/client";
import type { AuditEntry, Invitation, OpenWork } from "@/lib/types";
import { canResend, canRevoke, filterCounts, filterInvites, inviteStatus, statusChip } from "./inviteModel";
import { bookingsNote, needsHandover, openWorkSummary, refusalText } from "./handoverModel";
import { AUDIT_ACTIONS, auditLine } from "./auditModel";
import { MEMBER_ERROR_COPY, memberErrorText } from "./memberErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const BACKEND = resolve(__dirname, "../../../backend/src");

const NOW = new Date("2026-11-17T10:00:00Z");
const inv = (over: Partial<Invitation>): Invitation => ({
  id: "i1",
  email: "a@x.test",
  role: null,
  status: "pending",
  invitedBy: null,
  expiresAt: "2026-11-20T00:00:00Z",
  lastSentAt: "2026-11-17T09:00:00Z",
  sendCount: 1,
  createdAt: "2026-11-17T09:00:00Z",
  ...over,
});

describe("invite model", () => {
  it("invite status and filter counts", () => {
    const list = [
      inv({ id: "p" }),
      inv({ id: "late", expiresAt: "2026-11-17T09:59:59Z" }), // pending past expiresAt → expired
      inv({ id: "x", status: "expired", expiresAt: "2026-11-01T00:00:00Z" }),
      inv({ id: "a", status: "accepted" }),
      inv({ id: "r", status: "revoked" }),
    ];
    expect(list.map((i) => inviteStatus(i, NOW))).toEqual(["pending", "expired", "expired", "accepted", "revoked"]);
    const counts = filterCounts(list, NOW);
    expect(counts).toEqual({ all: 5, pending: 1, accepted: 1, expired: 2, revoked: 1 });
    for (const f of ["pending", "accepted", "expired", "revoked"] as const) {
      expect(filterInvites(list, f, NOW)).toHaveLength(counts[f]);
    }
    expect(filterInvites(list, "all", NOW)).toHaveLength(5);
    expect(statusChip("accepted", en).label).toBe("Active");
    expect(statusChip("pending", ar).label).toBe("بانتظار القبول");
  });

  it("resend and revoke follow the server's rules", () => {
    expect(canResend(inv({}), NOW)).toBe(true);
    expect(canResend(inv({ lastSentAt: "2026-11-17T09:59:30Z" }), NOW)).toBe(false); // within a minute
    expect(canResend(inv({ sendCount: 5 }), NOW)).toBe(false);
    expect(canResend(inv({ status: "accepted" }), NOW)).toBe(false);
    expect(canResend(inv({ status: "revoked" }), NOW)).toBe(false);
    expect(canResend(inv({ status: "expired" }), NOW)).toBe(true);
    expect(canResend(inv({ createdAt: "2026-11-01T00:00:00Z" }), NOW)).toBe(false); // past 14 days
    expect(canRevoke(inv({}), NOW)).toBe(true);
    expect(canRevoke(inv({ status: "accepted" }), NOW)).toBe(false);
  });
});

describe("handover model", () => {
  const work = (over: Partial<OpenWork>): OpenWork => ({
    conversations: 0, tickets: { deals: 0, leads: 0, support: 0 }, followUps: 0, contacts: 0, bookings: 0, total: 0, ...over,
  });

  it("handover summary lists only non-zero kinds and needs a recipient when total > 0", () => {
    const w = work({ conversations: 2, tickets: { deals: 1, leads: 0, support: 3 }, contacts: 1, bookings: 4, total: 7 });
    expect(openWorkSummary(w, en)).toEqual(["2 open conversations", "1 open deals", "3 open support tickets", "1 owned contacts"]);
    expect(openWorkSummary(w, ar).every((l) => ARABIC.test(l) && /^\d/.test(l))).toBe(true);
    expect(needsHandover(w)).toBe(true);
    // Bookings never count toward total: only bookings → no recipient needed.
    const onlyBookings = work({ bookings: 2, total: 0 });
    expect(needsHandover(onlyBookings)).toBe(false);
    expect(openWorkSummary(onlyBookings, en)).toEqual([]);
    expect(bookingsNote(onlyBookings, en)).toMatch(/^2 upcoming bookings/);
    expect(bookingsNote(work({}), en)).toBeNull();
    expect(refusalText({ reason: "missing_permission", resource: "tickets" }, en)).toMatch(/tickets/);
    expect(refusalText({ reason: "not_member" }, ar)).toMatch(ARABIC);
  });
});

/** Every `action: "x.y"` the backend writes (runtime files only). */
function backendAuditActions(): string[] {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== "__fixtures__") walk(p);
      } else if (name.endsWith(".ts") && !name.endsWith(".spec.ts")) {
        for (const m of readFileSync(p, "utf8").matchAll(/action: "((?:member|invitation|role|workspace|security)\.[a-z0-9_]+)"/g)) out.add(m[1]!);
      }
    }
  };
  walk(BACKEND);
  return [...out].sort();
}

describe("audit model", () => {
  it("audit line text covers every SP-26 action in both languages", () => {
    const actions = backendAuditActions();
    expect(actions.length).toBeGreaterThanOrEqual(15);
    expect(actions.filter((a) => !AUDIT_ACTIONS.includes(a))).toEqual([]);
    for (const action of AUDIT_ACTIONS) {
      const e: AuditEntry = {
        id: "a", action, actor: { id: "u", name: "Olivia" }, actorKind: "user", targetKind: "member",
        targetId: "t", targetLabel: "Adam", meta: null, createdAt: NOW.toISOString(),
      };
      const lineEn = auditLine(e, en);
      const lineAr = auditLine(e, ar);
      expect({ action, en: lineEn.startsWith("Olivia "), notKey: !lineEn.includes(action) }).toEqual({ action, en: true, notKey: true });
      expect({ action, ar: ARABIC.test(lineAr) }).toEqual({ action, ar: true });
    }
    expect(auditLine({ id: "a", action: "member.removed", actor: null, actorKind: "user", targetKind: "member", targetId: null, targetLabel: null, meta: { handoverTo: "u2" }, createdAt: "" }, en)).toBe(
      "Someone removed a removed record and handed over their work",
    );
  });
});

/** The keys of a backend STATUS table (`"a.b": 404,`). */
function backendKeys(file: string): string[] {
  const text = readFileSync(join(BACKEND, file), "utf8");
  return [...text.matchAll(/^\s+"([a-z0-9_]+\.[a-z0-9_]+)": \d{3},$/gm)].map((m) => m[1]!).sort();
}

describe("member errors", () => {
  it("member error copy covers every SP-26 key in both languages", () => {
    const keys = [...backendKeys("members/member-errors.ts"), ...backendKeys("auth/auth-errors.ts")];
    expect(keys.length).toBeGreaterThanOrEqual(23);
    expect(keys.filter((k) => !MEMBER_ERROR_COPY[k])).toEqual([]);
    for (const k of keys) {
      const [e, a] = MEMBER_ERROR_COPY[k]!;
      expect({ k, en: e.length > 0 && !ARABIC.test(e), ar: ARABIC.test(a) }).toEqual({ k, en: true, ar: true });
      expect(memberErrorText(new ApiError(k, 400, undefined, { statusCode: 400, message: k }), en)).toBe(e);
      expect(memberErrorText(new ApiError(k, 400, undefined, { statusCode: 400, message: k }), ar)).toBe(a);
    }
  });

  it("429s carry the retry time; unknown errors fall back to the message", () => {
    const limited = new ApiError("auth.rate_limited", 429, undefined, { message: "auth.rate_limited", retryAfterSec: 42 });
    expect(memberErrorText(limited, en)).toBe("Too many attempts. Try again in 42 s.");
    expect(memberErrorText(limited, ar)).toBe("محاولات كثيرة. حاول بعد 42 ث.");
    expect(memberErrorText(new ApiError("HTTP 429", 429), en)).toBe("Too many attempts. Try again later.");
    expect(memberErrorText(new ApiError("Missing permission", 403), ar)).toBe("ليست لديك صلاحية للقيام بذلك");
    expect(memberErrorText(new ApiError("Boom", 500), en)).toBe("Boom");
  });
});
