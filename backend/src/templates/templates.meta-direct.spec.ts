import { TemplatesService } from "./templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { ZernioClient } from "../integrations/zernio.client";
import { MetaTemplatesClient } from "../integrations/meta-templates.client";

/**
 * Templates for a WhatsApp number connected DIRECTLY to Meta (Embedded Signup,
 * coexistence or a pasted token) — no Zernio account involved.
 *
 * Before this, every template call required a Zernio integration, so a
 * Meta-connected workspace got "WhatsApp is not connected via Zernio" and
 * could not create a single template. These tests pin the direct path to the
 * real Graph API requests.
 */
describe("TemplatesService — WhatsApp connected directly to Meta", () => {
  const workspaceId = "ws1";
  const WABA = "waba-123";
  const TOKEN = "EAAtoken";

  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  const graphReply = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const build = (opts: { local?: Array<Record<string, unknown>> } = {}) => {
    const local = opts.local ?? [];
    // SP-19: the number is a channel. The Meta row carries the WABA in its
    // config; the Zernio lookup must find nothing for this workspace.
    const metaChannel = {
      id: "ch-meta",
      workspaceId,
      kind: "whatsapp",
      provider: "meta",
      status: "active",
      isDefault: true,
      externalId: "phone-1",
      integrationId: null,
      secretsEnc: JSON.stringify({ accessToken: TOKEN }),
      config: { wabaId: WABA },
    };
    const prisma = {
      channel: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([metaChannel]),
      },
      integration: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      template: {
        findMany: jest.fn().mockResolvedValue(local),
        findFirst: jest
          .fn()
          .mockImplementation(({ where }) =>
            Promise.resolve(local.find((r) => r.id === where.id) ?? null),
          ),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new", ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    const zernio = {
      whatsappTemplates: jest.fn(),
      createWhatsAppTemplate: jest.fn(),
      updateWhatsAppTemplate: jest.fn(),
      deleteWhatsAppTemplate: jest.fn(),
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      zernio as unknown as ZernioClient,
      undefined,
      new MetaTemplatesClient(),
    );
    return { svc, prisma, zernio };
  };

  it("submits a new template to the WABA on the Graph API, not to Zernio", async () => {
    fetchMock.mockReturnValueOnce(
      graphReply({ id: "meta-tpl-1", status: "PENDING", category: "UTILITY" }),
    );
    const { svc, prisma, zernio } = build();

    const row = await svc.create(workspaceId, {
      name: "order_update",
      lang: "en",
      category: "UTILITY",
      body: "Hi {{1}}, your order is ready.",
      footer: "Kewy",
      buttons: [{ type: "QUICK_REPLY", text: "Thanks" }],
    });

    expect(zernio.createWhatsAppTemplate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(new RegExp(`/${WABA}/message_templates$`));
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ name: "order_update", language: "en", category: "UTILITY" });
    // Meta's own casing for component discriminators.
    expect(body.components).toEqual([
      {
        type: "BODY",
        text: "Hi {{1}}, your order is ready.",
        example: { body_text: [["sample1"]] },
      },
      { type: "FOOTER", text: "Kewy" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Thanks" }] },
    ]);

    expect(row.status).toBe("pending");
    expect(row.metaTemplateId).toBe("meta-tpl-1");
    expect(prisma.template.create).toHaveBeenCalled();
  });

  it("reconciles the list against the WABA's templates on the Graph API", async () => {
    fetchMock.mockReturnValueOnce(
      graphReply({
        data: [
          {
            id: "meta-tpl-1",
            name: "order_update",
            language: "en",
            status: "APPROVED",
            category: "UTILITY",
            components: [{ type: "BODY", text: "Hi {{1}}" }],
          },
        ],
      }),
    );
    const { svc, zernio } = build({
      local: [{ id: "t1", name: "order_update", lang: "en", status: "pending", uses: 0 }],
    });

    const rows = await svc.list(workspaceId);

    expect(zernio.whatsappTemplates).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/${WABA}/message_templates?`);
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("approved");
    expect(rows[0].metaTemplateId).toBe("meta-tpl-1");
  });

  it("follows Graph paging so templates past the first page are not marked local", async () => {
    fetchMock
      .mockReturnValueOnce(
        graphReply({
          data: [{ id: "a", name: "first", language: "en", status: "APPROVED", category: "UTILITY" }],
          paging: { next: "https://graph.facebook.com/v21.0/next-page" },
        }),
      )
      .mockReturnValueOnce(
        graphReply({
          data: [{ id: "b", name: "second", language: "en", status: "APPROVED", category: "UTILITY" }],
        }),
      );
    const { svc } = build({
      local: [{ id: "t2", name: "second", lang: "en", status: "approved", uses: 0, metaTemplateId: "b" }],
    });

    const rows = await svc.list(workspaceId);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows.find((r) => r.name === "second")?.status).toBe("approved");
  });

  it("sends a content edit to the template's own Graph node", async () => {
    fetchMock.mockReturnValueOnce(graphReply({ success: true }));
    const { svc } = build({
      local: [
        {
          id: "t1",
          name: "order_update",
          lang: "en",
          category: "UTILITY",
          status: "approved",
          uses: 0,
          body: "Old",
          metaTemplateId: "meta-tpl-1",
        },
      ],
    });

    const row = await svc.update(workspaceId, "t1", { body: "New body" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/meta-tpl-1$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).components).toEqual([{ type: "BODY", text: "New body" }]);
    // Meta re-reviews every edit.
    expect(row.status).toBe("pending");
  });

  it("deletes the template at Meta by name", async () => {
    fetchMock.mockReturnValueOnce(graphReply({ success: true }));
    const { svc, prisma } = build({
      local: [
        { id: "t1", name: "order_update", lang: "en", status: "approved", uses: 0, metaTemplateId: "meta-tpl-1" },
      ],
    });

    await svc.remove(workspaceId, "t1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(url).toContain(`/${WABA}/message_templates?`);
    expect(url).toContain("name=order_update");
    expect(prisma.template.delete).toHaveBeenCalled();
  });

  it("refuses an image header clearly instead of sending Meta a URL it can't use", async () => {
    const { svc } = build();

    await expect(
      svc.create(workspaceId, {
        name: "promo",
        lang: "en",
        category: "MARKETING",
        body: "Hi",
        headerType: "image",
        headerContent: "https://example.com/a.png",
      }),
    ).rejects.toThrow(/headers aren't supported yet/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Meta's rejection message when the Graph API refuses a template", async () => {
    fetchMock.mockReturnValueOnce(
      graphReply({ error: { message: "Invalid parameter", error_user_msg: "Name already exists" } }, 400),
    );
    const { svc, prisma } = build();

    await expect(
      svc.create(workspaceId, { name: "dup", lang: "en", category: "UTILITY", body: "Hi" }),
    ).rejects.toThrow(/Name already exists/);
    expect(prisma.template.create).not.toHaveBeenCalled();
  });
});

describe("TemplatesService — no WhatsApp connection at all", () => {
  it("says WhatsApp is not connected without blaming Zernio", async () => {
    const prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      integration: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      {} as unknown as ZernioClient,
      undefined,
      new MetaTemplatesClient(),
    );

    const err = await svc
      .create("ws1", { name: "x", lang: "en", category: "UTILITY", body: "Hi" })
      .catch((e: Error) => e);

    // SP-13 ruling 6: one keyed 409 for every marketing action — the key names
    // WhatsApp, never the provider behind it.
    expect(err).toMatchObject({
      status: 409,
      response: { message: "campaigns.whatsapp_not_connected" },
    });
    expect(JSON.stringify(err)).not.toMatch(/Zernio/i);
  });
});
