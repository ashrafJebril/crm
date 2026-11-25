import { AiBridgeService } from "./ai-bridge.service";
import { ZernioClient } from "./zernio.client";
import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { makeFakePrisma } from "../channels/test-prisma";
import { HealthCheckTrigger } from "../channels/health/health-check-trigger";

/**
 * WhatsApp template sends over the Zernio transport.
 *
 * Templates are the ONLY message type WhatsApp accepts once the 24-hour
 * customer-service window has closed, so this path is what makes an outside
 * window reply possible at all. Zernio carries it on the same
 * POST /inbox/conversations/{id}/messages endpoint as free text, via a
 * `template.elements[0]` reference whose `components` array is forwarded to
 * Meta's Cloud API verbatim (spec v1.0.4, live-probed 2026-08-28).
 */
describe("ZernioClient.sendTemplateMessage", () => {
  let client: ZernioClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "test-key";
    client = new ZernioClient();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true, data: { messageId: "m9" } })),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("posts the template reference in Meta's element shape and returns the message id", async () => {
    const res = await client.sendTemplateMessage("z-conv", "acc1", {
      name: "order_confirmed_v2",
      language: "en",
      components: [{ type: "body", parameters: [{ type: "text", text: "David" }] }],
    });

    expect(res).toEqual({ id: "m9" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/inbox/conversations/z-conv/messages");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.accountId).toBe("acc1");
    expect(body.template).toEqual({
      elements: [
        {
          name: "order_confirmed_v2",
          language: "en",
          components: [{ type: "body", parameters: [{ type: "text", text: "David" }] }],
        },
      ],
    });
  });

  it("omits components when the template takes no variables", async () => {
    await client.sendTemplateMessage("z-conv", "acc1", {
      name: "greetings",
      language: "en",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.template.elements[0]).toEqual({ name: "greetings", language: "en" });
    expect("components" in body.template.elements[0]).toBe(false);
  });

  it("never sends a `message` field alongside a template", async () => {
    // Meta rejects a send that carries both a template and free text; Zernio
    // forwards the body as-is, so the guard has to live here.
    await client.sendTemplateMessage("z-conv", "acc1", { name: "greetings", language: "en" });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.message).toBeUndefined();
  });
});

describe("ZernioService.sendTemplateInDbConversation", () => {
  const workspaceId = "ws1";

  const build = (
    overrides: {
      conversation?: Record<string, unknown> | null;
      integration?: Record<string, unknown> | null;
    } = {},
  ) => {
    const prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(
          overrides.conversation === undefined
            ? {
                id: "conv-db",
                channel: "whatsapp",
                externalId: "z-conv",
                contactId: "c1",
                contact: { externalId: "p1" },
              }
            : overrides.conversation,
        ),
        update: jest.fn().mockResolvedValue({}),
      },
      integration: {
        findFirst: jest.fn().mockResolvedValue(
          overrides.integration === undefined
            ? { pageId: "acc1", platform: "whatsapp", provider: "zernio" }
            : overrides.integration,
        ),
        findMany: jest.fn().mockResolvedValue([]),
      },
      // SP-19: the send account comes from the conversation's channel — here
      // the channel mirrored from the integration above (none when it is null).
      channel: {
        findMany: jest.fn().mockResolvedValue(
          overrides.integration === null
            ? []
            : [
                {
                  id: "ch1",
                  workspaceId,
                  kind: "whatsapp",
                  provider: (overrides.integration?.provider as string) ?? "zernio",
                  externalId: "acc1",
                  status: "active",
                  isDefault: true,
                  integrationId: "i1",
                },
              ],
        ),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      message: { create: jest.fn().mockResolvedValue({}) },
    };
    const client = {
      sendTemplateMessage: jest.fn().mockResolvedValue({ id: "m9" }),
    };
    const svc = new ZernioService(
      prisma as unknown as PrismaService,
      { emitToWorkspace: jest.fn() } as unknown as RealtimeService,
      {} as unknown as MediaService,
      client as unknown as ZernioClient,
      { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
      { ask: jest.fn(), enabled: false } as never,
        { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
);
    return { svc, client, prisma };
  };

  it("maps positional variables onto a Meta body component", async () => {
    const { svc, client } = build();

    await svc.sendTemplateInDbConversation(workspaceId, "conv-db", "order_confirmed_v2", "en", [
      "David",
      "Bread",
    ]);

    expect(client.sendTemplateMessage).toHaveBeenCalledWith("z-conv", "acc1", {
      name: "order_confirmed_v2",
      language: "en",
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "David" },
            { type: "text", text: "Bread" },
          ],
        },
      ],
    });
  });

  it("sends no components for a template with no variables", async () => {
    // An empty parameters array is a 400 at Meta, so the component must be
    // absent rather than present-and-empty.
    const { svc, client } = build();

    await svc.sendTemplateInDbConversation(workspaceId, "conv-db", "greetings", "en", []);

    expect(client.sendTemplateMessage).toHaveBeenCalledWith("z-conv", "acc1", {
      name: "greetings",
      language: "en",
    });
  });

  it("persists a readable preview so the thread does not render an empty bubble", async () => {
    const { svc, prisma } = build();

    await svc.sendTemplateInDbConversation(workspaceId, "conv-db", "order_confirmed_v2", "en", [
      "David",
    ]);

    const created = prisma.message.create.mock.calls[0][0].data;
    expect(created.body).toBe("[template: order_confirmed_v2] David");
    expect(created.from).toBe("human");
    expect(created.metaMessageId).toBe("m9");
  });

  it("refuses a thread that is not WhatsApp", async () => {
    const { svc } = build({
      conversation: {
        id: "conv-db",
        channel: "instagram",
        externalId: "z-conv",
        contactId: "c1",
        contact: { externalId: "p1" },
      },
    });

    await expect(
      svc.sendTemplateInDbConversation(workspaceId, "conv-db", "greetings", "en", []),
    ).rejects.toThrow(/only.*whatsapp/i);
  });

  it("reports the real reason when WhatsApp is not connected via Zernio", async () => {
    const { svc } = build({ integration: { pageId: "pn", platform: "whatsapp", provider: "meta" } });

    await expect(
      svc.sendTemplateInDbConversation(workspaceId, "conv-db", "greetings", "en", []),
    ).rejects.toThrow(/not connected via Zernio/i);
  });

  it("409 channels.not_connected when no channel resolves for the thread", async () => {
    const { svc, client } = build({ integration: null });

    await expect(
      svc.sendTemplateInDbConversation(workspaceId, "conv-db", "greetings", "en", []),
    ).rejects.toMatchObject({ status: 409, response: { message: "channels.not_connected" } });
    expect(client.sendTemplateMessage).not.toHaveBeenCalled();
  });
});

describe("ZernioClient template management", () => {
  let client: ZernioClient;
  let fetchMock: jest.Mock;

  const respond = (payload: unknown) =>
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
    });

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "test-key";
    client = new ZernioClient();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("lists the WABA's templates with Meta's real status", async () => {
    respond({
      success: true,
      templates: [
        { id: "meta-1", name: "order_update", status: "APPROVED", category: "UTILITY", language: "en" },
      ],
    });

    const templates = await client.whatsappTemplates("acc1");

    expect(String(fetchMock.mock.calls[0][0])).toContain("/whatsapp/templates?accountId=acc1");
    expect(templates).toHaveLength(1);
    expect(templates[0].status).toBe("APPROVED");
  });

  it("returns an empty list rather than throwing when the WABA has none", async () => {
    // Live-probed 2026-08-28: a fresh WABA answers 200 with no templates key.
    respond({ success: true });

    await expect(client.whatsappTemplates("acc1")).resolves.toEqual([]);
  });

  it("submits a custom template with its components", async () => {
    respond({ success: true, template: { id: "meta-new", name: "order_ready", status: "PENDING" } });

    const created = await client.createWhatsAppTemplate({
      accountId: "acc1",
      name: "order_ready",
      category: "UTILITY",
      language: "en",
      components: [{ type: "BODY", text: "Hi {{1}}" }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      accountId: "acc1",
      name: "order_ready",
      category: "UTILITY",
      language: "en",
      components: [{ type: "BODY", text: "Hi {{1}}" }],
    });
    expect(created.id).toBe("meta-new");
  });

  it("uses Meta's snake_case library field, and sends no components with it", async () => {
    // The wire contract is `library_template_name`; a camelCase key is silently
    // ignored by Zernio and the template comes back needing review instead.
    respond({ success: true, template: { id: "meta-lib", name: "appointment_reminder", status: "APPROVED" } });

    await client.createWhatsAppTemplate({
      accountId: "acc1",
      name: "appointment_reminder",
      category: "UTILITY",
      language: "en",
      libraryTemplateName: "appointment_reminder",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.library_template_name).toBe("appointment_reminder");
    expect(body.components).toBeUndefined();
  });

  it("looks up a library template by exact name", async () => {
    respond({
      template: {
        name: "appointment_reminder",
        language: "en_US",
        category: "UTILITY",
        body: "Your appointment is on {{1}}",
        body_params: ["date"],
        buttons: [{ type: "URL", text: "Reschedule" }],
      },
    });

    const found = await client.whatsappLibraryTemplate("acc1", "appointment_reminder", "en");

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/whatsapp/template-library");
    expect(url).toContain("name=appointment_reminder");
    expect(url).toContain("language=en");
    expect(found?.buttons?.[0].type).toBe("URL");
  });

  it("returns null when no library template matches", async () => {
    respond({ template: null });

    await expect(client.whatsappLibraryTemplate("acc1", "nope")).resolves.toBeNull();
  });
});

// ─── SP-14 Task 2: whatsapp.template.status_updated (ruling 15) ─────────────
describe("zernio template status webhook (SP-14)", () => {
  const build = () => {
    const prisma = makeFakePrisma({
      channel: [
        { id: "chA", workspaceId: "wsA", kind: "whatsapp", provider: "zernio", externalId: "accA", displayName: "A", status: "active", isDefault: true, updatedAt: new Date("2026-01-02") },
        { id: "chA2", workspaceId: "wsA", kind: "whatsapp", provider: "zernio", externalId: "accA2", displayName: "A2", status: "active", isDefault: false, updatedAt: new Date("2026-01-01") },
        { id: "chB", workspaceId: "wsB", kind: "whatsapp", provider: "zernio", externalId: "accB", displayName: "B", status: "active", isDefault: true, updatedAt: new Date("2026-01-01") },
        { id: "chOld", workspaceId: "wsB", kind: "whatsapp", provider: "zernio", externalId: "accGone", displayName: "Old", status: "disconnected", updatedAt: new Date("2026-01-01") },
      ],
      template: [
        { id: "tA", workspaceId: "wsA", name: "promo", lang: "en", status: "approved", metaTemplateId: "m_A", metaRejectionReason: null },
        { id: "tB", workspaceId: "wsB", name: "promo", lang: "en", status: "approved", metaTemplateId: "m_B", metaRejectionReason: null },
      ],
    } as never);
    const trigger = new HealthCheckTrigger();
    const checks: Array<[string, string]> = [];
    trigger.bind(async (ws, id) => void checks.push([ws, id]));
    const svc = new ZernioService(
      prisma as never,
      { emitToWorkspace: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      trigger,
    );
    const status = (id: string) => (prisma.db.template as Array<{ id: string; status: string }>).find((t) => t.id === id)?.status;
    const evt = (accountId: string, template: Record<string, unknown>) => ({ event: "whatsapp.template.status_updated", account: { accountId }, template });
    return { prisma, svc, trigger, checks, status, evt };
  };

  it("paused and disabled map from every source: the Zernio webhook", async () => {
    const w = build();
    expect(await w.svc.handleEvent(w.evt("accA", { templateId: "m_A", name: "promo", language: "en_US", status: "PAUSED" }))).toEqual({ ok: true });
    expect(w.status("tA")).toBe("paused");
    await w.svc.handleEvent(w.evt("accA", { templateId: "m_A", name: "promo", language: "en_US", status: "DISABLED" }));
    expect(w.status("tA")).toBe("disabled");
    await w.svc.handleEvent(w.evt("accA", { templateId: "m_A", status: "REJECTED", reason: "INVALID_FORMAT" }));
    expect(w.prisma.db.template[0]).toMatchObject({ status: "rejected", metaRejectionReason: "INVALID_FORMAT" });
    await w.svc.handleEvent(w.evt("accA", { templateId: "m_A", status: "IN_APPEAL" }));
    expect(w.status("tA")).toBe("pending");
    await w.svc.handleEvent(w.evt("accA", { templateId: "m_A", status: "APPROVED" }));
    expect(w.prisma.db.template[0]).toMatchObject({ status: "approved", metaRejectionReason: null });
    // A status we do not know changes nothing (never defaulted).
    await w.svc.handleEvent(w.evt("accA", { templateId: "m_A", status: "SOMETHING_NEW" }));
    expect(w.status("tA")).toBe("approved");
  });

  it("template webhook is scoped to the owning workspace", async () => {
    const w = build();
    // By name only (no id), for workspace A's default number: only A's row changes.
    await w.svc.handleEvent(w.evt("accA", { name: "promo", language: "en_US", status: "PAUSED" }));
    expect(w.status("tA")).toBe("paused");
    expect(w.status("tB")).toBe("approved");
    // An id of the other workspace's template, sent for A's account, changes nothing in B.
    await w.svc.handleEvent(w.evt("accA", { templateId: "m_B", name: "other", language: "en", status: "DISABLED" }));
    expect(w.status("tB")).toBe("approved");
    // A pause of a copy on a non-default number never rewrites the default-number rows by name.
    await w.svc.handleEvent(w.evt("accA2", { templateId: "m_A2", name: "promo", language: "en", status: "DISABLED" }));
    expect(w.status("tA")).toBe("paused");
    // Unknown and disconnected-only accounts change nothing and check nothing.
    const before = w.checks.length;
    await w.svc.handleEvent(w.evt("accX", { templateId: "m_A", status: "DISABLED" }));
    await w.svc.handleEvent(w.evt("accGone", { templateId: "m_B", status: "DISABLED" }));
    expect(w.status("tA")).toBe("paused");
    expect(w.status("tB")).toBe("approved");
    await w.trigger.idle();
    expect(w.checks.length).toBe(before);
  });

  it("each event schedules a webhook check of the number it came from", async () => {
    const w = build();
    await w.svc.handleEvent(w.evt("accA2", { templateId: "m_A2", name: "promo", language: "en", status: "PAUSED" }));
    await w.svc.handleEvent(w.evt("accB", { templateId: "m_B", status: "FLAGGED" }));
    await w.trigger.idle();
    expect(w.checks).toEqual([
      ["wsA", "chA2"],
      ["wsB", "chB"],
    ]);
  });

  it("a check failure never fails the webhook", async () => {
    const w = build();
    w.trigger.bind(async () => {
      throw new Error("boom");
    });
    await expect(w.svc.handleEvent(w.evt("accA", { templateId: "m_A", status: "PAUSED" }))).resolves.toEqual({ ok: true });
    await w.trigger.idle();
  });
});
