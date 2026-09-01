import { AiBridgeService } from "./ai-bridge.service";
import { ZernioClient } from "./zernio.client";
import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";

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
      },
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
    const { svc } = build({ integration: null });

    await expect(
      svc.sendTemplateInDbConversation(workspaceId, "conv-db", "greetings", "en", []),
    ).rejects.toThrow(/not connected via Zernio/i);
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
