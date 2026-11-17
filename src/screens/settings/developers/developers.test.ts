import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeTx } from "@/lib/tx";
import { ApiError } from "@/api/client";
import { notificationText } from "@/lib/notificationText";
import {
  KEY_ACTIONS,
  KEY_RESOURCES,
  WEBHOOK_EVENTS,
  deliveryStatusLabel,
  deliveryTone,
  emptyMatrix,
  expiryInstant,
  keyStatus,
  lastErrorText,
  matrixToScopes,
  toggleRow,
  toggleScope,
  disabledReasonText,
  emptyRow,
} from "./apiModel";
import { DEVELOPER_ERROR_COPY, developerErrorText } from "./developerErrors";
import { UNDOCUMENTED_KEY_ROUTES } from "./undocumentedRoutes";
import { SHOWN_ONCE_CLOSE_CONFIRM, closeDecision, guardedClose, modalDismissible } from "./shownOnceGuard";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const BACKEND = resolve(__dirname, "../../../../backend/src");
const read = (p: string) => readFileSync(resolve(BACKEND, p), "utf8");
const listOf = (text: string, name: string) =>
  [...(new RegExp(`export const ${name} = \\[([^\\]]+)\\]`).exec(text)?.[1] ?? "").matchAll(/"([a-z_.]+)"/g)].map((m) => m[1]!);

describe("API key model", () => {
  it("scope matrix implications and serialization", () => {
    let row = toggleScope(emptyRow(), "write", true);
    expect(row).toEqual({ read: true, write: true, delete: false, admin: false });
    row = toggleScope(emptyRow(), "admin", true);
    expect(row).toEqual({ read: true, write: true, delete: true, admin: true });
    // Unticking read clears write and admin; unticking anything clears admin.
    expect(toggleScope(row, "read", false)).toEqual({ read: false, write: false, delete: true, admin: false });
    expect(toggleScope(row, "delete", false)).toEqual({ read: true, write: true, delete: false, admin: false });
    expect(toggleRow(emptyRow())).toEqual({ read: true, write: true, delete: true, admin: true });
    expect(toggleRow(toggleRow(emptyRow()))).toEqual(emptyRow());

    const m = emptyMatrix();
    m.contacts = toggleScope(emptyRow(), "write", true);
    m.tickets = toggleScope(emptyRow(), "admin", true);
    m.reports = toggleScope(emptyRow(), "read", true);
    m.bookings = toggleScope(emptyRow(), "delete", true);
    // The backend shape (validateScopes accepts it as-is).
    expect(matrixToScopes(m)).toEqual({ contacts: ["read", "write"], tickets: ["admin"], bookings: ["delete"], reports: ["read"] });
    expect(matrixToScopes(emptyMatrix())).toEqual({});
  });

  it("key and delivery status helpers", () => {
    const now = new Date("2026-11-18T10:00:00Z");
    expect(keyStatus({ revokedAt: null, expiresAt: null }, now)).toBe("active");
    expect(keyStatus({ revokedAt: null, expiresAt: "2026-11-18T09:59:59Z" }, now)).toBe("expired");
    // Revoked wins over expired.
    expect(keyStatus({ revokedAt: "2026-11-01T00:00:00Z", expiresAt: "2026-11-02T00:00:00Z" }, now)).toBe("revoked");
    expect(deliveryTone({ status: "delivered", attempts: 2 })).toBe("ok");
    expect(deliveryTone({ status: "failed", attempts: 6 })).toBe("bad");
    expect(deliveryTone({ status: "pending", attempts: 1 })).toBe("warn");
    expect(deliveryTone({ status: "pending", attempts: 0 })).toBe("");
    expect(deliveryStatusLabel({ status: "pending", attempts: 1 }, ar)).toBe("إعادة المحاولة");
    expect(deliveryStatusLabel({ status: "delivered", attempts: 1 }, ar)).toBe("تم التسليم");
    expect(lastErrorText("http_503", en)).toBe("The endpoint answered 503.");
    expect(lastErrorText("http_503", ar)).toContain("503");
    expect(lastErrorText(null, en)).toBeNull();
    expect(disabledReasonText({ active: false, disabledReason: "failing" }, en)).toContain("72 hours");
    expect(disabledReasonText({ active: true, disabledReason: null }, en)).toBeNull();
  });

  it("lastError copy covers every reason the dispatcher writes", () => {
    const text = [read("webhooks/webhook-dispatcher.ts"), read("common/safe-fetch.ts")].join("\n");
    const found = [...text.matchAll(/(?:lastError|error): (?:timedOut \? )?"([a-z_]+)"(?: : "([a-z_]+)")?/g)].flatMap((m) => [m[1]!, m[2]].filter(Boolean) as string[]);
    const reasons = new Set(found);
    for (const r of ["timeout", "network_error", "dns_error", "redirect", "unsafe_url", "endpoint_disabled"]) expect({ r, found: reasons.has(r) }).toEqual({ r, found: true });
    for (const r of reasons) {
      expect({ r, generic: lastErrorText(r, en) === "Delivery failed." }).toEqual({ r, generic: false });
      expect(lastErrorText(r, ar)).toMatch(ARABIC);
    }
  });

  it("webhook event list equals the backend list", () => {
    expect([...WEBHOOK_EVENTS]).toEqual(listOf(read("webhooks/webhook-events.ts"), "WEBHOOK_EVENTS"));
    const scopes = read("api-keys/api-key-scopes.ts");
    expect([...KEY_RESOURCES]).toEqual(listOf(scopes, "KEY_RESOURCES"));
    expect([...KEY_ACTIONS]).toEqual(listOf(scopes, "KEY_ACTIONS"));
  });
});

describe("developer errors", () => {
  it("developer error copy covers every SP-27 key in both languages", () => {
    const keys = [read("api-keys/api-key-errors.ts"), read("webhooks/webhook-errors.ts")].flatMap((t) =>
      [...t.matchAll(/^\s+"((?:api_keys|webhooks)\.[a-z_]+)": \d{3},$/gm)].map((m) => m[1]!),
    );
    expect(keys.length).toBeGreaterThanOrEqual(16);
    expect(Object.keys(DEVELOPER_ERROR_COPY).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      const [e, a] = DEVELOPER_ERROR_COPY[k]!;
      expect({ k, en: e.length > 0 && !ARABIC.test(e), ar: ARABIC.test(a) }).toEqual({ k, en: true, ar: true });
      expect(developerErrorText(new ApiError(k, 400, undefined, { message: k }), en)).toBe(e);
      expect(developerErrorText(new ApiError(k, 400, undefined, { message: k }), ar)).toBe(a);
    }
    expect(developerErrorText(new ApiError("Missing permission", 403), ar)).toBe("ليست لديك صلاحية للقيام بذلك");
  });

  it("the webhook-disabled notification has copy in both languages", () => {
    const title = /WEBHOOK_DISABLED_TITLE = "([a-z_.]+)"/.exec(read("webhooks/webhook-dispatcher.ts"))?.[1];
    expect(title).toBe("webhooks.endpoint_disabled");
    const n = (reason: string) => ({
      type: "connector_needs_attention",
      title: title!,
      body: JSON.stringify({ endpointId: "e1", url: "https://hooks.example.com/in", reason }),
    });
    const e = notificationText(en, n("failing"));
    expect(e.title).toBe("A webhook was turned off");
    expect(e.body).toContain("hooks.example.com");
    expect(e.body).toContain("72 hours");
    const a = notificationText(ar, n("unsafe_url"));
    expect(a.title).toMatch(ARABIC);
    expect(a.body).toMatch(ARABIC);
  });
});

describe("developers page", () => {
  const html = readFileSync(resolve(__dirname, "../../../../public/developers.html"), "utf8");
  const map = read("permissions/permission-map.ts");
  const RULE = (key: string) => new RegExp(`"${key.replace(/[/:]/g, (c) => `\\${c}`)}": "([a-z_.]+)"`).exec(map)?.[1];

  it("every documented route exists and is callable with a key", () => {
    const routes = [...html.matchAll(/data-route="((?:GET|POST|PATCH|PUT|DELETE) \/[^"]+)"/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const r of routes) {
      const rule = RULE(r);
      // Mapped to a permission on a resource a key may hold (never "authenticated" or "public").
      expect({ r, rule: rule ?? null, keyable: !!rule && (KEY_RESOURCES as readonly string[]).includes(rule.split(".")[0]!) }).toEqual({
        r,
        rule: rule ?? null,
        keyable: true,
      });
    }
  });

  it("each documented scope level matches the route's real requirement", () => {
    // read = view; write = create or update; delete = delete; admin = manage (api-key-scopes.ts ACTION_MAP).
    const LEVEL: Record<string, string[]> = { read: ["view"], write: ["create", "update"], delete: ["delete"], admin: ["manage"] };
    const rows = [...html.matchAll(/data-route="((?:GET|POST|PATCH|PUT|DELETE) \/[^"]+)"><td>.*?<\/td><td>([a-z_]+): ([a-z]+)<\/td>/g)];
    const routes = [...html.matchAll(/data-route="/g)];
    expect(rows.length).toBe(routes.length); // every row states "resource: level"
    for (const [, r, resource, level] of rows) {
      const [res, action] = (RULE(r!) ?? ".").split(".");
      expect({ r, documented: `${resource}: ${level}`, ok: res === resource && (LEVEL[level!] ?? []).includes(action!) }).toEqual({
        r,
        documented: `${resource}: ${level}`,
        ok: true,
      });
    }
  });

  it("every key-reachable route is documented or listed as undocumented with a reason", () => {
    const documented = new Set([...html.matchAll(/data-route="((?:GET|POST|PATCH|PUT|DELETE) \/[^"]+)"/g)].map((m) => m[1]!));
    const keyable = [...map.matchAll(/"((?:GET|POST|PATCH|PUT|DELETE) \/[^"]+)": "([a-z_]+)\.[a-z]+"/g)]
      .filter((m) => (KEY_RESOURCES as readonly string[]).includes(m[2]!))
      .map((m) => m[1]!);
    const listed = UNDOCUMENTED_KEY_ROUTES.flatMap((g) => g.routes);
    for (const g of UNDOCUMENTED_KEY_ROUTES) expect(g.reason.length).toBeGreaterThan(20);
    // No duplicates, nothing both documented and listed, nothing stale.
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.filter((r) => documented.has(r))).toEqual([]);
    expect(listed.filter((r) => !keyable.includes(r))).toEqual([]);
    // Every key-reachable route is accounted for.
    expect(keyable.filter((r) => !documented.has(r) && !listed.includes(r))).toEqual([]);
  });

  it("every documented event exists, and every event is documented", () => {
    const events = [...html.matchAll(/data-event="([a-z_.]+)"/g)].map((m) => m[1]!);
    expect([...new Set(events)].sort()).toEqual([...WEBHOOK_EVENTS].sort());
  });

  it("documents the signature scheme, the replay window and both languages", () => {
    expect(html).toContain("X-Crm-Signature");
    expect(html).toMatch(/t=\d*…?,v1=|t=&lt;|t=</);
    expect(html).toContain("Authorization: Bearer crm_");
    expect(html).toContain("createHmac(\"sha256\"");
    expect(html).toMatch(/300/);
    expect(html).toMatch(ARABIC);
    expect(html).toMatch(/dir="ltr"|setAttribute\("dir"/);
  });
});

describe("SP-27 review fixes", () => {
  it("a shown-once secret only closes freely after it was copied", () => {
    const shown = { secretShown: true, copied: false };
    expect(closeDecision({ ...shown, via: "escape" })).toBe("ignore");
    expect(closeDecision({ ...shown, via: "backdrop" })).toBe("ignore");
    expect(closeDecision({ ...shown, via: "button" })).toBe("confirm");
    expect(closeDecision({ secretShown: true, copied: true, via: "escape" })).toBe("close");
    expect(closeDecision({ secretShown: false, copied: false, via: "backdrop" })).toBe("close");
    expect(modalDismissible(shown)).toBe(false);
    expect(modalDismissible({ secretShown: true, copied: true })).toBe(true);

    const close = vi.fn();
    guardedClose(shown, close, () => false, "m");
    expect(close).not.toHaveBeenCalled();
    const ask = vi.fn(() => true);
    guardedClose(shown, close, ask, makeTx("ar")(...SHOWN_ONCE_CLOSE_CONFIRM));
    expect(ask).toHaveBeenCalledWith("لن تتمكن من رؤيته مرة أخرى. هل تريد الإغلاق؟");
    expect(close).toHaveBeenCalledTimes(1);
    const noAsk = vi.fn();
    guardedClose({ secretShown: true, copied: true }, close, noAsk, "m");
    expect(noAsk).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(2);
    expect(makeTx("en")(...SHOWN_ONCE_CLOSE_CONFIRM)).toBe("You won't see this again. Close anyway?");
  });

  it("a key expiry day ends at 23:59:59 in the workspace timezone, not the browser's", () => {
    expect(expiryInstant("2027-03-10", "Asia/Riyadh")).toBe("2027-03-10T20:59:59.000Z");
    expect(expiryInstant("2027-03-10", "America/New_York")).toBe("2027-03-11T04:59:59.000Z");
    expect(expiryInstant("2027-07-10", "America/New_York")).toBe("2027-07-11T03:59:59.000Z"); // daylight time
  });
});

