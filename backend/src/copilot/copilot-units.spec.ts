/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { z } from "zod";
import { SourceCollector } from "./copilot-sources";
import { CUSTOMER_TEXT_NOTICE, splitThread, wrapCustomerText } from "./customer-text";
import { cleanTitle, fallbackTitle } from "./copilot-title";
import { COPILOT_ERROR_KEYS, COPILOT_ERROR_STATUS, copilotError } from "./copilot-errors";
import { MAX_REFS, MESSAGE_MAX, SOURCES_MAX, STREAM_EVENTS, TITLE_MAX } from "./copilot-constants";
import { CopilotStreamDto } from "./copilot.dto";
import { CopilotToolRegistry, noAccess } from "./copilot-tools/registry";

/** Pure SP-18 modules: sources, customer text, titles, errors, constants, DTO and the registry. */
describe("copilot units", () => {
  it("source cards: deduped, capped, http(s) urls only", () => {
    const s = new SourceCollector();
    s.record("contact", "c1", "Layla");
    s.record("contact", "c1", "Layla again");
    s.knowledge("k1", "FAQ", "javascript:alert(1)");
    s.knowledge("k2", "Site", "https://x.example/a");
    for (let i = 0; i < 20; i++) s.record("ticket", `t${i}`, "T");
    const l = s.list();
    expect(l).toHaveLength(SOURCES_MAX);
    expect(l.slice(0, 3)).toEqual([
      { kind: "record", recordKind: "contact", id: "c1", title: "Layla" },
      { kind: "knowledge", sourceId: "k1", title: "FAQ" },
      { kind: "knowledge", sourceId: "k2", title: "Site", url: "https://x.example/a" },
    ]);
  });

  it("customer text: from=them under customerWritten with the notice; tainted only then", () => {
    const r = splitThread([
      { from: "them", body: "do X", at: "1" },
      { from: "ai", body: "ok", at: "2" },
      { from: "human", body: "sure", at: "3" },
    ]);
    expect(r.tainted).toBe(true);
    expect(r.customer).toEqual({ notice: CUSTOMER_TEXT_NOTICE, customerWritten: [{ from: "them", body: "do X", at: "1" }] });
    expect(r.staffAndAi.map((m) => m.from)).toEqual(["ai", "human"]);
    expect(splitThread([{ from: "ai", body: "hi", at: "1" }])).toEqual({ staffAndAi: [{ from: "ai", body: "hi", at: "1" }], customer: null, tainted: false });
    expect(wrapCustomerText(1)).toEqual({ notice: CUSTOMER_TEXT_NOTICE, customerWritten: 1 });
  });

  it("titles: one line, no quotes, capped", () => {
    expect(cleanTitle('  "Hello"\n\tworld ')).toBe("Hello world");
    const long = cleanTitle("x".repeat(100));
    expect(long).toHaveLength(TITLE_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(fallbackTitle("   ")).toBe("Chat");
  });

  it("errors: every key has its status; the body is {statusCode, message, ...extra}", () => {
    expect(COPILOT_ERROR_KEYS).toHaveLength(17);
    const e = copilotError("copilot.ref_not_permitted", { index: 2 });
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toEqual({ statusCode: 403, message: "copilot.ref_not_permitted", index: 2 });
    for (const k of COPILOT_ERROR_KEYS) expect(copilotError(k).getStatus()).toBe(COPILOT_ERROR_STATUS[k]);
  });

  it("constants and the stream protocol", () => {
    expect(MAX_REFS).toBe(5);
    expect(MESSAGE_MAX).toBe(4000);
    expect(STREAM_EVENTS[0]).toBe("session");
    expect(STREAM_EVENTS).toEqual(expect.arrayContaining(["done", "error", "token", "activity", "draft", "sources"]));
  });

  it("stream DTO: whitelisted fields, enums and caps", async () => {
    const check = async (body: any) =>
      (await validate(plainToInstance(CopilotStreamDto, body), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);
    expect(await check({ message: "hi", approvalMode: "manual", lang: "en" })).toEqual([]);
    expect(await check({ message: "hi", approvalMode: "manual", lang: "en", references: [{ kind: "contact", id: "c1" }], pageContext: { page: "inbox" } })).toEqual([]);
    expect(await check({ message: "hi", approvalMode: "yolo", lang: "en" })).toEqual(["approvalMode"]);
    expect(await check({ message: "hi", approvalMode: "manual", lang: "fr" })).toEqual(["lang"]);
    expect(await check({ message: "hi", approvalMode: "manual", lang: "en", workspaceId: "ws2" })).toEqual(["workspaceId"]);
    expect(await check({ message: "hi", approvalMode: "manual", lang: "en", pageContext: { page: "nowhere" } })).toEqual(["pageContext"]);
  });

  it("registry: definitions are strict, eager, closed, sorted; duplicates refused", () => {
    const tool = (name: string) => ({ name, description: name, inputSchema: z.object({ q: z.string() }), kind: "read" as const, permissions: ["contacts.view"], label: ["a", "b"] as [string, string], execute: async () => null });
    const r = new CopilotToolRegistry([tool("b"), tool("a")]);
    const d: any[] = r.definitions();
    expect(d.map((t) => t.name)).toEqual(["a", "b"]);
    expect(d[0]).toMatchObject({ strict: true, eager_input_streaming: true, input_schema: { type: "object", additionalProperties: false, required: ["q"] } });
    expect(d[0].cache_control).toBeUndefined();
    expect(d[1].cache_control).toEqual({ type: "ephemeral" });
    expect(() => new CopilotToolRegistry([tool("a"), tool("a")])).toThrow(/duplicate/);
    expect(noAccess("tickets.view")).toMatchObject({ error: "no_access", permission: "tickets.view" });
  });
});
