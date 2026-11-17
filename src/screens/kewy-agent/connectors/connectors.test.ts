import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeTx } from "@/lib/tx";
import { ApiError } from "@/api/client";
import { notificationText } from "@/lib/notificationText";
import { notificationHref } from "@/lib/recordLink";
import type { ConnectorTool } from "@/lib/types";
import {
  CONNECTOR_PROVIDER_KEYS,
  OAUTH_REASONS,
  acceptOAuthMessage,
  attentionLines,
  cardKind,
  cardKindText,
  flagText,
  isExposed,
  oauthReasonText,
  oauthResultFromHash,
  rescanNotice,
  switchReasonText,
  switchState,
  writeWarning,
} from "./connectorModel";
import { CONNECTOR_ERROR_COPY, connectorErrorText } from "./connectorErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const BACKEND = resolve(__dirname, "../../../../backend/src/connectors");
const read = (f: string) => readFileSync(resolve(BACKEND, f), "utf8");

const tool = (over: Partial<ConnectorTool>): ConnectorTool => ({
  name: "t",
  title: null,
  description: "",
  kind: "read",
  access: "off",
  exposed: false,
  removed: false,
  flag: null,
  ownerRead: false,
  ...over,
});

describe("connector tools", () => {
  it("tool switched off is not exposed to agent", () => {
    // The truth table of the backend rule (connector-tools.ts isExposed): on,
    // not removed, and read or switched to "write".
    const table: [ConnectorTool["kind"], ConnectorTool["access"], boolean, boolean][] = [
      ["read", "off", false, false],
      ["read", "read", false, true],
      ["read", "write", false, true],
      ["write", "off", false, false],
      ["write", "read", false, false],
      ["write", "write", false, true],
      ["read", "read", true, false],
      ["write", "write", true, false],
    ];
    for (const [kind, access, removed, exposed] of table) {
      expect({ kind, access, removed, exposed: isExposed({ kind, access, removed }) }).toEqual({ kind, access, removed, exposed });
    }
    // The backend source states the same rule.
    const src = read("connector-tools.ts");
    expect(src).toMatch(/if \(tool\.access === "off" \|\| tool\.removedAt\) return false;/);
    expect(src).toMatch(/return tool\.access === "write" \|\| tool\.kind === "read";/);
  });

  it("write switch needs manage and shows the warning", () => {
    const updater = (p: string) => p === "connectors.view" || p === "connectors.update";
    const owner = () => true;
    const w = tool({ name: "cancel_event", kind: "write" });
    expect(switchState(w, updater, "active")).toMatchObject({ disabled: true, reason: "needs_manage", onAccess: "write" });
    expect(switchReasonText("needs_manage", en)).toContain("owner or an admin");
    expect(switchState(w, owner, "active")).toMatchObject({ disabled: false, needsConfirm: true, onAccess: "write" });
    expect(writeWarning("Calendly", en)).toBe("The agent will be able to change data in Calendly on its own.");
    expect(writeWarning("Calendly", ar)).toBe("سيتمكن الوكيل من تعديل البيانات في Calendly بنفسه.");
    // Switching a write tool OFF needs no manage.
    expect(switchState(tool({ kind: "write", access: "write" }), updater, "active")).toMatchObject({ disabled: false, on: true, needsConfirm: false });
    // Read tools need update only; viewers see them read-only; removed tools never switch.
    expect(switchState(tool({ kind: "read" }), updater, "active")).toMatchObject({ disabled: false, onAccess: "read" });
    expect(switchState(tool({ kind: "read" }), (p) => p === "connectors.view", "active")).toMatchObject({ disabled: true, reason: "no_permission" });
    expect(switchState(tool({ kind: "read", removed: true }), owner, "active")).toMatchObject({ disabled: true, reason: "removed" });
    expect(switchReasonText("removed", ar)).toBe("أزالها المزوّد");
    // Flags explain why a re-scan switched a tool off.
    for (const f of ["reclassified", "description_changed", "schema_changed"] as const) {
      expect(flagText(f, en)).toMatch(/^Switched off for safety/);
      expect(flagText(f, ar)).toMatch(ARABIC);
    }
    expect(flagText(null, en)).toBeNull();
  });

  it("rescan notice lists added, removed and changed tools in both languages", () => {
    const r = { added: ["a"], removed: ["b"], changed: ["c", "d"] };
    expect(rescanNotice(r, en)).toEqual(["New tools (switched off): a", "Removed by the provider: b", "Changed by the provider: c, d"]);
    expect(rescanNotice(r, ar)).toEqual(["أدوات جديدة (متوقفة): a", "أزالها المزوّد: b", "غيّرها المزوّد: c، d"]);
    expect(rescanNotice({ added: [], removed: [], changed: [] }, en)).toEqual(["No changes: the tools are up to date."]);
  });
});

describe("gallery states", () => {
  it("cards, attention banner and the needs_reconnect notification", () => {
    expect(cardKind({ available: true, unavailableReason: null })).toBe("available");
    expect(cardKindText(cardKind({ available: false, unavailableReason: "coming_soon" }), ar)).toBe("قريبًا");
    expect(cardKindText(cardKind({ available: false, unavailableReason: "not_configured" }), en)).toBe("Not configured on this server");
    const s = (status: any, name = "Calendly") => ({ id: `id_${name}`, provider: "calendly", name, status, statusReason: null, accountLabel: null, agentBound: true, toolCounts: { on: 1, total: 2 }, connectedAt: null, calls7d: 0 });
    expect(attentionLines([s("active"), s("needs_reconnect", "HubSpot")], ar)).toEqual([{ id: "id_HubSpot", provider: "calendly", text: "يحتاج HubSpot إلى إعادة الربط" }]);
    const n = { type: "connector_needs_attention", title: "connectors.needs_reconnect", body: JSON.stringify({ provider: "calendly", name: "Calendly", reason: "invalid_grant", connectorId: "conn_1" }) };
    expect(notificationText(en, n).title).toBe("Calendly needs reconnecting");
    expect(notificationText(ar, n).title).toBe("يحتاج Calendly إلى إعادة الربط");
    expect(notificationHref(n)).toBe("#/agent?tab=connectors&connector=conn_1");
    // The title constant is the backend's.
    expect(read("connector-attention.service.ts")).toContain('CONNECTOR_NEEDS_RECONNECT_TITLE = "connectors.needs_reconnect"');
  });
});

describe("oauth popup", () => {
  const ok = { type: "kewy-connector-oauth", connected: true, connectorId: "conn_1", reason: null };
  it("oauth popup accepts messages only from the backend origin", () => {
    const backend = "https://api.example.com";
    expect(acceptOAuthMessage({ origin: backend, data: ok }, backend)).toEqual({ connected: true, connectorId: "conn_1", reason: null });
    for (const origin of ["https://evil.example.com", "https://api.example.com.evil.com", "null", "", "http://api.example.com"]) {
      expect({ origin, r: acceptOAuthMessage({ origin, data: ok }, backend) }).toEqual({ origin, r: null });
    }
    for (const data of [null, "connected", { ...ok, type: "other" }, { ...ok, connected: "yes" }, [ok]]) {
      expect(acceptOAuthMessage({ origin: backend, data }, backend)).toBeNull();
    }
    // An unknown reason is reported as exchange_failed; a bad id is dropped.
    expect(acceptOAuthMessage({ origin: backend, data: { ...ok, connected: false, reason: "<img>", connectorId: "x\"y" } }, backend)).toEqual({ connected: false, connectorId: null, reason: "exchange_failed" });
    expect(acceptOAuthMessage({ origin: backend, data: ok }, "")).toBeNull();
  });

  it("every OAuth outcome has copy, and the full-page fallback reads the hash", () => {
    expect([...OAUTH_REASONS].sort()).toEqual(
      [...(/CONNECTOR_OAUTH_REASONS = \[([^\]]+)\]/.exec(read("connector-errors.ts"))?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort(),
    );
    for (const r of OAUTH_REASONS) {
      expect(oauthReasonText(r, en)).not.toBe("Connected.");
      expect(oauthReasonText(r, ar)).toMatch(ARABIC);
    }
    expect(oauthResultFromHash("#/agent?tab=connectors&connector=c1&connected=0&reason=forbidden")).toEqual({ connected: false, connectorId: "c1", reason: "forbidden" });
    expect(oauthResultFromHash("#/agent?tab=connectors&connected=1")).toMatchObject({ connected: true, reason: null });
    expect(oauthResultFromHash("#/agent?tab=connectors")).toBeNull();
  });
});

describe("errors and catalog", () => {
  it("connector error copy covers every SP-23 key in both languages", () => {
    const keys = [...read("connector-errors.ts").matchAll(/^\s+"(connectors\.[a-z_]+)": \d{3},$/gm)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThanOrEqual(13);
    expect(Object.keys(CONNECTOR_ERROR_COPY).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      const [e, a] = CONNECTOR_ERROR_COPY[k]!;
      expect({ k, en: e.length > 0 && !ARABIC.test(e), ar: ARABIC.test(a) }).toEqual({ k, en: true, ar: true });
      expect(connectorErrorText(new ApiError(k, 409, undefined, { message: k }), ar)).toBe(a);
    }
    expect(connectorErrorText(new ApiError("connectors.version_conflict", 409, undefined, { message: "connectors.version_conflict" }), en)).toBe("Someone else changed this connector");
    expect(connectorErrorText(new ApiError("connectors.unsafe_url", 400, undefined, { message: "connectors.unsafe_url", reason: "private_address" }), en)).toContain("private or local network");
    expect(connectorErrorText(new ApiError("nope", 403), ar)).toBe("ليست لديك صلاحية للقيام بذلك");
  });

  it("catalog keys equal the backend keys", () => {
    const providers = [...read("connector-catalog.ts").matchAll(/^\s+provider: "([a-z]+)",$/gm)].map((m) => m[1]);
    expect([...CONNECTOR_PROVIDER_KEYS]).toEqual(providers);
  });
});
