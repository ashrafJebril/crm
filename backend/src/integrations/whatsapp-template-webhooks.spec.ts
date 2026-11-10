import { Logger } from "@nestjs/common";
import { makeFakePrisma } from "../channels/test-prisma";
import { HealthCheckTrigger } from "../channels/health/health-check-trigger";
import { WhatsAppService } from "./whatsapp.service";

/** SP-14 Task 2: Meta's template status, template quality and phone quality webhooks. */
function build() {
  const prisma = makeFakePrisma({
    integration: [{ id: "int1", workspaceId: "wsL", platform: "whatsapp", provider: "meta", pageId: "pn_L", raw: JSON.stringify({ wabaId: "waba_L" }) }],
    channel: [
      { id: "chM", workspaceId: "wsA", kind: "whatsapp", provider: "meta", externalId: "pn_1", displayName: "Meta 1", phoneNumber: "+962 79 000 0001", status: "active", config: { wabaId: "waba_A" } },
      { id: "chM2", workspaceId: "wsA", kind: "whatsapp", provider: "meta", externalId: "pn_2", displayName: "Meta 2", phoneNumber: "+962790000002", status: "active", config: { wabaId: "waba_A" } },
      { id: "chOther", workspaceId: "wsB", kind: "whatsapp", provider: "meta", externalId: "pn_3", displayName: "Other", phoneNumber: "+962790000001", status: "active", config: { wabaId: "waba_B" } },
      { id: "chGone", workspaceId: "wsA", kind: "whatsapp", provider: "meta", externalId: "pn_4", displayName: "Gone", phoneNumber: "+962790000004", status: "disconnected", config: { wabaId: "waba_A" } },
      { id: "chL", workspaceId: "wsL", kind: "whatsapp", provider: "meta", externalId: "pn_L", displayName: "Legacy", phoneNumber: "15550001111", status: "active", integrationId: "int1", config: null },
    ],
    template: [
      { id: "t1", workspaceId: "wsA", name: "promo", lang: "en", status: "approved", metaTemplateId: "111", quality: null, metaRejectionReason: null },
      { id: "t2", workspaceId: "wsB", name: "promo", lang: "en", status: "approved", metaTemplateId: "222", quality: null, metaRejectionReason: null },
    ],
  } as never);
  const trigger = new HealthCheckTrigger();
  const checks: Array<[string, string]> = [];
  trigger.bind(async (ws, id) => void checks.push([ws, id]));
  const svc = new WhatsAppService(prisma, {} as never, {} as never, {} as never, {} as never, undefined, undefined, undefined, undefined, trigger);
  const row = (id: string) => (prisma.db.template as Array<Record<string, unknown>>).find((t) => t.id === id)!;
  const hook = (field: string, value: Record<string, unknown>, entryId = "waba_A") =>
    svc.handleWebhook({ object: "whatsapp_business_account", entry: [{ id: entryId, changes: [{ field, value: value as never }] }] });
  return { prisma, svc, trigger, checks, row, hook };
}

describe("Meta template and quality webhooks (SP-14)", () => {
  beforeEach(() => {
    for (const m of ["log", "warn", "debug"] as const) jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("paused and disabled map from every source: Meta's status webhook (FLAGGED leaves the status)", async () => {
    const w = build();
    const status = async (event: string, extra: Record<string, unknown> = {}) => {
      await w.hook("message_template_status_update", { event, message_template_id: 111, message_template_name: "promo", message_template_language: "en_US", ...extra });
      return w.row("t1").status;
    };
    expect(await status("PAUSED")).toBe("paused");
    // Meta: a flagged template is still sendable. FLAGGED changes no status.
    expect(await status("FLAGGED")).toBe("paused");
    expect(await status("REINSTATED")).toBe("approved");
    expect(await status("FLAGGED")).toBe("approved");
    expect(await status("DISABLED")).toBe("disabled");
    expect(await status("APPROVED")).toBe("approved");
    expect(await status("REJECTED", { reason: "INVALID_FORMAT" })).toBe("rejected");
    expect(w.row("t1").metaRejectionReason).toBe("INVALID_FORMAT");
    expect(await status("PENDING_DELETION")).toBe("pending");
    expect(w.row("t2").status).toBe("approved");
  });

  it("the template quality webhook sets Template.quality by id (UNKNOWN → NOT_RATED) and triggers a check only", async () => {
    const w = build();
    const q = async (score: unknown, id: unknown = 111) => {
      await w.hook("message_template_quality_update", {
        previous_quality_score: "GREEN",
        new_quality_score: score,
        message_template_id: id,
        message_template_name: "promo",
        message_template_language: "en_US",
      });
      return w.row("t1").quality;
    };
    expect(await q("YELLOW")).toBe("YELLOW");
    expect(await q("UNKNOWN")).toBe("NOT_RATED");
    expect(await q("RED")).toBe("RED");
    // An unrecognised score or an unknown id changes nothing.
    expect(await q("PURPLE")).toBe("RED");
    expect(await q("GREEN", 999)).toBe("RED");
    expect(w.row("t2").quality).toBeNull();
    // The status is never touched by a quality event.
    expect(w.row("t1").status).toBe("approved");
    // It asks for a check of the WABA's Meta numbers; the payload sets no health field.
    await w.trigger.idle();
    expect(new Set(w.checks.map(([ws, id]) => `${ws}:${id}`))).toEqual(new Set(["wsA:chM", "wsA:chM2"]));
    expect(w.prisma.db.channel.every((c: { health?: unknown }) => c.health == null)).toBe(true);
  });

  it("the WABA lookup filters in the query and batches Integration reads (review m3)", async () => {
    const w = build();
    // Many Meta numbers of other WABAs and tenants, several legacy-linked.
    for (let i = 0; i < 30; i++) {
      w.prisma.db.integration.push({ id: `intX${i}`, workspaceId: `wsX${i}`, platform: "whatsapp", provider: "meta", pageId: `pnX${i}`, raw: JSON.stringify({ wabaId: `waba_X${i}` }) });
      w.prisma.db.channel.push(
        { id: `chX${i}`, workspaceId: `wsX${i}`, kind: "whatsapp", provider: "meta", externalId: `pnX${i}`, displayName: "x", phoneNumber: `+1555000${i}`, status: "active", config: { wabaId: `waba_Y${i}` } },
        { id: `chL${i}`, workspaceId: `wsX${i}`, kind: "whatsapp", provider: "meta", externalId: `pnL${i}`, displayName: "x", phoneNumber: `+1666000${i}`, status: "active", config: null, integrationId: `intX${i}` },
      );
    }
    const chFind = jest.spyOn(w.prisma.channel, "findMany");
    const intMany = jest.spyOn(w.prisma.integration, "findMany");
    const intFirst = jest.spyOn(w.prisma.integration, "findFirst");

    await w.hook("message_template_quality_update", { new_quality_score: "RED", message_template_id: 111 });
    await w.hook("phone_number_quality_update", { display_phone_number: "+1 555-000-1111" }, "waba_L");
    await w.trigger.idle();
    expect(new Set(w.checks.map(([, id]) => id))).toEqual(new Set(["chM", "chM2", "chL"]));

    // Per event: one Integration query and one Channel query, whatever the number of Meta numbers.
    expect(intFirst).not.toHaveBeenCalled();
    expect(intMany).toHaveBeenCalledTimes(2);
    expect(chFind).toHaveBeenCalledTimes(2);
    // The Channel query is scoped to the WABA: the config JSON path, or the WABA's legacy Integrations.
    const call = (i: number) => (chFind.mock.calls[i][0] as { where: { OR: unknown } }).where;
    const where = call(0);
    expect(where.OR).toEqual([{ config: { path: ["wabaId"], equals: "waba_A" } }, { integrationId: { in: [] } }]);
    expect(call(1).OR).toEqual([{ config: { path: ["wabaId"], equals: "waba_L" } }, { integrationId: { in: ["int1"] } }]);
  });

  it("a legacy-linked number whose config names another WABA is not matched through its Integration", async () => {
    const w = build();
    w.prisma.db.channel.find((c: { id: string }) => c.id === "chL").config = { wabaId: "waba_other" };
    await w.hook("phone_number_quality_update", { display_phone_number: "15550001111" }, "waba_L");
    await w.trigger.idle();
    expect(w.checks).toEqual([]);
  });

  it("the phone quality webhook triggers a check of the matching Meta number only", async () => {
    const w = build();
    await w.hook("phone_number_quality_update", { display_phone_number: "962790000001", event: "DOWNGRADE", current_limit: "TIER_250" });
    await w.trigger.idle();
    // By WABA and display number: not chM2 (other number), not chOther (other WABA), not chGone (disconnected).
    expect(w.checks).toEqual([["wsA", "chM"]]);
    expect(w.prisma.db.channel.every((c: { health?: unknown }) => c.health == null)).toBe(true);

    // A legacy-linked number: the WABA comes from Integration.raw.
    await w.hook("phone_number_quality_update", { display_phone_number: "+1 555-000-1111", event: "FLAGGED" }, "waba_L");
    await w.trigger.idle();
    expect(w.checks).toEqual([
      ["wsA", "chM"],
      ["wsL", "chL"],
    ]);

    // Unknown WABA or number: nothing.
    await w.hook("phone_number_quality_update", { display_phone_number: "962790000009", event: "DOWNGRADE" });
    await w.hook("phone_number_quality_update", { display_phone_number: "962790000001", event: "DOWNGRADE" }, "waba_X");
    await w.trigger.idle();
    expect(w.checks).toHaveLength(2);
  });
});
