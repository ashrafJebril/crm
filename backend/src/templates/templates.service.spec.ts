import { TemplatesService } from "./templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { ZernioClient } from "../integrations/zernio.client";

/**
 * Templates must report META's verdict, not a local guess.
 *
 * The old controller stored `status: "approved"` on any row it could not submit
 * (and the demo seed did the same), so the Templates screen showed four
 * "approved" templates that Meta had never heard of — and every send failed.
 * Zernio proxies the WhatsApp Cloud API, so its list IS Meta's truth; these
 * tests pin the reconciliation to it.
 */
describe("TemplatesService.list — reconciliation against Meta", () => {
  const workspaceId = "ws1";

  const build = (opts: {
    local?: Array<Record<string, unknown>>;
    meta?: Array<Record<string, unknown>> | Error;
    accountId?: string | null;
  }) => {
    const local = opts.local ?? [];
    const prisma = {
      integration: {
        findFirst: jest.fn().mockResolvedValue(
          opts.accountId === null ? null : { pageId: opts.accountId ?? "acc1", provider: "zernio" },
        ),
      },
      template: {
        findMany: jest.fn().mockResolvedValue(local),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve(data)),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new", ...data })),
      },
    };
    const client = {
      whatsappTemplates: jest.fn().mockImplementation(() =>
        opts.meta instanceof Error ? Promise.reject(opts.meta) : Promise.resolve(opts.meta ?? []),
      ),
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      client as unknown as ZernioClient,
    );
    return { svc, prisma, client };
  };

  it("reports Meta's verdict instead of the locally stored status", async () => {
    const { svc } = build({
      local: [{ id: "t1", name: "order_confirmed_v2", lang: "en", status: "approved", uses: 4812 }],
      meta: [
        {
          id: "meta-1",
          name: "order_confirmed_v2",
          language: "en",
          status: "REJECTED",
          category: "UTILITY",
        },
      ],
    });

    const rows = await svc.list(workspaceId);

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected");
  });

  it("marks a local row Meta has never seen as `local`, never approved", async () => {
    const { svc } = build({
      local: [{ id: "t1", name: "greetings", lang: "en", status: "approved", uses: 0 }],
      meta: [],
    });

    const rows = await svc.list(workspaceId);

    expect(rows[0].status).toBe("local");
    expect(rows[0].status).not.toBe("approved");
  });

  it("imports a template that exists at Meta but not locally", async () => {
    const { svc, prisma } = build({
      local: [],
      meta: [
        {
          id: "meta-9",
          name: "hello_world",
          language: "en_US",
          status: "APPROVED",
          category: "UTILITY",
          components: [{ type: "BODY", text: "Hello {{1}}" }],
        },
      ],
    });

    const rows = await svc.list(workspaceId);

    expect(prisma.template.create).toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("hello_world");
    expect(rows[0].status).toBe("approved");
    // The EXACT Meta language must survive — sending "en" for an "en_US"
    // template is a template-not-found error at Meta.
    expect(rows[0].lang).toBe("en_US");
  });

  it("keeps the local uses counter when Meta confirms a template", async () => {
    const { svc } = build({
      local: [{ id: "t1", name: "appointment_24h", lang: "en", status: "approved", uses: 1304 }],
      meta: [
        {
          id: "meta-2",
          name: "appointment_24h",
          language: "en",
          status: "APPROVED",
          category: "UTILITY",
        },
      ],
    });

    const rows = await svc.list(workspaceId);

    expect(rows[0].uses).toBe(1304);
  });

  it("extracts body, footer and buttons out of Meta's components", async () => {
    const { svc } = build({
      local: [],
      meta: [
        {
          id: "meta-3",
          name: "order_update",
          language: "en",
          status: "APPROVED",
          category: "UTILITY",
          components: [
            { type: "HEADER", format: "TEXT", text: "Your order" },
            { type: "BODY", text: "Hi {{1}}, your order is ready." },
            { type: "FOOTER", text: "Reply STOP to opt out" },
            {
              type: "BUTTONS",
              buttons: [{ type: "QUICK_REPLY", text: "Thanks" }],
            },
          ],
        },
      ],
    });

    const rows = await svc.list(workspaceId);

    expect(rows[0].body).toBe("Hi {{1}}, your order is ready.");
    expect(rows[0].footer).toBe("Reply STOP to opt out");
    expect(rows[0].headerType).toBe("text");
    expect(rows[0].headerContent).toBe("Your order");
    expect(JSON.parse(rows[0].buttons as string)).toEqual([
      { type: "QUICK_REPLY", text: "Thanks" },
    ]);
  });

  it("still refuses to claim approved when Zernio is unreachable", async () => {
    // A Zernio outage must not resurrect the old fiction: an unverifiable row
    // reports `local`, so the screen never promises a send that cannot work.
    const { svc } = build({
      local: [
        { id: "t1", name: "greetings", lang: "en", status: "approved", uses: 0, metaTemplateId: null },
      ],
      meta: new Error("Zernio API unreachable"),
    });

    const rows = await svc.list(workspaceId);

    expect(rows[0].status).toBe("local");
  });

  it("trusts a previously confirmed row when Zernio is unreachable", async () => {
    const { svc } = build({
      local: [
        {
          id: "t1",
          name: "order_update",
          lang: "en",
          status: "approved",
          uses: 3,
          metaTemplateId: "meta-3",
        },
      ],
      meta: new Error("Zernio API unreachable"),
    });

    const rows = await svc.list(workspaceId);

    expect(rows[0].status).toBe("approved");
  });

  it("reports local rows as local when WhatsApp is not connected at all", async () => {
    const { svc, client } = build({
      accountId: null,
      local: [{ id: "t1", name: "greetings", lang: "en", status: "approved", uses: 0 }],
    });

    const rows = await svc.list(workspaceId);

    expect(client.whatsappTemplates).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("local");
  });
});

describe("TemplatesService.create — real submission only", () => {
  const workspaceId = "ws1";

  const build = (accountId: string | null = "acc1") => {
    const prisma = {
      integration: {
        findFirst: jest
          .fn()
          .mockResolvedValue(accountId === null ? null : { pageId: accountId, provider: "zernio" }),
      },
      template: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "t9", ...data })),
      },
    };
    const client = {
      createWhatsAppTemplate: jest.fn().mockResolvedValue({
        id: "meta-new",
        name: "order_ready",
        status: "PENDING",
        category: "UTILITY",
        language: "en",
      }),
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      client as unknown as ZernioClient,
    );
    return { svc, prisma, client };
  };

  it("submits a custom template and records Meta's pending verdict", async () => {
    const { svc, prisma, client } = build();

    const row = await svc.create(workspaceId, {
      name: "order_ready",
      lang: "en",
      category: "UTILITY",
      body: "Hi {{1}}, your order is ready.",
      footer: "Thanks",
    });

    expect(client.createWhatsAppTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "acc1",
        name: "order_ready",
        category: "UTILITY",
        language: "en",
      }),
    );
    // Body/footer must reach Meta as real components, not just a local column.
    const sent = client.createWhatsAppTemplate.mock.calls[0][0];
    // Zernio validates the component discriminator as LOWERCASE — sending
    // Meta's uppercase "BODY" is rejected with "Invalid discriminator value.
    // Expected 'header' | 'body' | 'footer' | 'buttons' | ..." (hit live
    // 2026-08-28 creating a template from the UI).
    expect(sent.components).toEqual([
      {
        type: "body",
        text: "Hi {{1}}, your order is ready.",
        // Meta rejects a variable with no sample value — see the
        // "requires sample values" suite below.
        example: { body_text: [["sample1"]] },
      },
      { type: "footer", text: "Thanks" },
    ]);
    expect(row.status).toBe("pending");
    expect(prisma.template.create.mock.calls[0][0].data.metaTemplateId).toBe("meta-new");
    expect(prisma.template.create.mock.calls[0][0].data.submittedAt).toBeInstanceOf(Date);
  });

  it("creates from Meta's library as approved, with no review wait", async () => {
    const { svc, client } = build();
    client.createWhatsAppTemplate.mockResolvedValue({
      id: "meta-lib",
      name: "appointment_reminder",
      status: "APPROVED",
      category: "UTILITY",
      language: "en",
    });

    const row = await svc.create(workspaceId, {
      name: "appointment_reminder",
      lang: "en",
      category: "UTILITY",
      libraryTemplateName: "appointment_reminder",
    });

    expect(client.createWhatsAppTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ libraryTemplateName: "appointment_reminder" }),
    );
    // Library templates carry no components of our own.
    expect(client.createWhatsAppTemplate.mock.calls[0][0].components).toBeUndefined();
    expect(row.status).toBe("approved");
  });

  it("refuses to invent an approved template when WhatsApp is not connected", async () => {
    const { svc, prisma } = build(null);

    await expect(
      svc.create(workspaceId, {
        name: "order_ready",
        lang: "en",
        category: "UTILITY",
        body: "hi",
      }),
    ).rejects.toThrow(/not connected/i);
    expect(prisma.template.create).not.toHaveBeenCalled();
  });
});

describe("TemplatesService.create — category translation", () => {
  it("submits a TRANSACTIONAL template as UTILITY", async () => {
    // Meta retired TRANSACTIONAL and 400s on it, but our seed and older rows
    // still use it — including order_confirmed_v2 in the demo workspace.
    const prisma = {
      integration: { findFirst: jest.fn().mockResolvedValue({ pageId: "acc1" }) },
      template: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "t9", ...data })) },
    };
    const client = {
      createWhatsAppTemplate: jest
        .fn()
        .mockResolvedValue({ id: "m1", name: "order_confirmed_v2", status: "PENDING", language: "en" }),
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      client as unknown as ZernioClient,
    );

    const row = await svc.create("ws1", {
      name: "order_confirmed_v2",
      lang: "en",
      category: "TRANSACTIONAL",
      body: "Order confirmed",
    });

    expect(client.createWhatsAppTemplate.mock.calls[0][0].category).toBe("UTILITY");
    // Our own row keeps the label the user chose.
    expect(row.category).toBe("TRANSACTIONAL");
  });
});

describe("TemplatesService.update — edits reach Meta", () => {
  const build = (row: Record<string, unknown>) => {
    const prisma = {
      integration: { findFirst: jest.fn().mockResolvedValue({ pageId: "acc1" }) },
      template: {
        findFirst: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...row, ...data })),
      },
    };
    const client = {
      updateWhatsAppTemplate: jest
        .fn()
        .mockResolvedValue({ id: "meta-1", name: "order_update", status: "PENDING", language: "en" }),
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      client as unknown as ZernioClient,
    );
    return { svc, prisma, client };
  };

  it("sends a content edit to Meta and records the pending re-review", async () => {
    // A local-only edit would be pointless: the next list() reconciliation
    // overwrites our columns from Meta's components, silently discarding it.
    const { svc, client } = build({
      id: "t1",
      name: "order_update",
      lang: "en",
      category: "UTILITY",
      status: "approved",
      metaTemplateId: "meta-1",
    });

    const row = await svc.update("ws1", "t1", { body: "New body {{1}}" });

    expect(client.updateWhatsAppTemplate).toHaveBeenCalledWith("acc1", "order_update", [
      { type: "body", text: "New body {{1}}", example: { body_text: [["sample1"]] } },
    ]);
    expect(row.status).toBe("pending");
  });

  it("edits a local-only row without contacting Meta", async () => {
    const { svc, client } = build({
      id: "t2",
      name: "greetings",
      lang: "en",
      category: "UTILITY",
      status: "local",
      metaTemplateId: null,
    });

    const row = await svc.update("ws1", "t2", { body: "Hi there" });

    expect(client.updateWhatsAppTemplate).not.toHaveBeenCalled();
    expect(row.status).toBe("local");
  });
});

describe("TemplatesService.duplicate", () => {
  it("makes the copy local — a duplicate has no Meta approval of its own", async () => {
    const prisma = {
      template: {
        findFirst: jest.fn().mockResolvedValue({
          id: "t1",
          name: "order_update",
          lang: "en",
          category: "UTILITY",
          status: "approved",
          metaTemplateId: "meta-1",
          uses: 4812,
          body: "Hi {{1}}",
        }),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "t2", ...data })),
      },
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      {} as unknown as ZernioClient,
    );

    const copy = await svc.duplicate("ws1", "t1");

    expect(copy.status).toBe("local");
    expect(copy.metaTemplateId).toBeNull();
    expect(copy.uses).toBe(0);
    expect(copy.name).toBe("order_update_copy");
  });
});

describe("TemplatesService.remove", () => {
  const build = (row: Record<string, unknown>, deleteFails = false) => {
    const prisma = {
      integration: { findFirst: jest.fn().mockResolvedValue({ pageId: "acc1" }) },
      template: {
        findFirst: jest.fn().mockResolvedValue(row),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    const client = {
      deleteWhatsAppTemplate: deleteFails
        ? jest.fn().mockRejectedValue(new Error("Meta rejected the delete"))
        : jest.fn().mockResolvedValue(undefined),
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      client as unknown as ZernioClient,
    );
    return { svc, prisma, client };
  };

  it("deletes at Meta too, so reconciliation cannot resurrect it", async () => {
    const { svc, prisma, client } = build({
      id: "t1",
      name: "order_update",
      lang: "en",
      metaTemplateId: "meta-1",
    });

    await svc.remove("ws1", "t1");

    expect(client.deleteWhatsAppTemplate).toHaveBeenCalledWith("acc1", "order_update");
    expect(prisma.template.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
  });

  it("keeps our row when Meta refuses the delete", async () => {
    // Dropping the local row while Meta still has the template would make it
    // silently reappear on the next list().
    const { svc, prisma } = build(
      { id: "t1", name: "order_update", lang: "en", metaTemplateId: "meta-1" },
      true,
    );

    await expect(svc.remove("ws1", "t1")).rejects.toThrow(/could not delete/i);
    expect(prisma.template.delete).not.toHaveBeenCalled();
  });

  it("deletes a local-only row without calling Meta", async () => {
    const { svc, prisma, client } = build({
      id: "t2",
      name: "greetings",
      lang: "en",
      metaTemplateId: null,
    });

    await svc.remove("ws1", "t2");

    expect(client.deleteWhatsAppTemplate).not.toHaveBeenCalled();
    expect(prisma.template.delete).toHaveBeenCalled();
  });
});

describe("TemplatesService.list — write only on change", () => {
  it("does not touch the DB when Meta agrees with what we already stored", async () => {
    // list() runs on every Templates screen load. Writing a row per template
    // per read would mean N pointless UPDATEs on a page that only reads.
    const stored = {
      id: "t1",
      name: "order_update",
      lang: "en",
      category: "UTILITY",
      status: "approved",
      uses: 7,
      metaTemplateId: "meta-1",
      body: "Hi {{1}}",
      footer: null,
      headerType: null,
      headerContent: null,
      buttons: null,
    };
    const prisma = {
      integration: { findFirst: jest.fn().mockResolvedValue({ pageId: "acc1" }) },
      template: {
        findMany: jest.fn().mockResolvedValue([stored]),
        update: jest.fn(),
        create: jest.fn(),
      },
    };
    const client = {
      whatsappTemplates: jest.fn().mockResolvedValue([
        {
          id: "meta-1",
          name: "order_update",
          language: "en",
          status: "APPROVED",
          category: "UTILITY",
          components: [{ type: "BODY", text: "Hi {{1}}" }],
        },
      ]),
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      client as unknown as ZernioClient,
    );

    const rows = await svc.list("ws1");

    expect(prisma.template.update).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("approved");
    expect(rows[0].uses).toBe(7);
  });

  it("writes when Meta's verdict has actually changed", async () => {
    const prisma = {
      integration: { findFirst: jest.fn().mockResolvedValue({ pageId: "acc1" }) },
      template: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "t1",
            name: "order_update",
            lang: "en",
            category: "UTILITY",
            status: "pending",
            uses: 0,
            metaTemplateId: "meta-1",
            body: "Hi {{1}}",
          },
        ]),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn(),
      },
    };
    const client = {
      whatsappTemplates: jest.fn().mockResolvedValue([
        {
          id: "meta-1",
          name: "order_update",
          language: "en",
          status: "APPROVED",
          category: "UTILITY",
          components: [{ type: "BODY", text: "Hi {{1}}" }],
        },
      ]),
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      client as unknown as ZernioClient,
    );

    const rows = await svc.list("ws1");

    expect(prisma.template.update).toHaveBeenCalled();
    expect(rows[0].status).toBe("approved");
  });
});

describe("TemplatesService.create — Zernio's lowercase component contract", () => {
  const build = () => {
    const prisma = {
      integration: { findFirst: jest.fn().mockResolvedValue({ pageId: "acc1" }) },
      template: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "t9", ...data })) },
    };
    const client = {
      createWhatsAppTemplate: jest
        .fn()
        .mockResolvedValue({ id: "m1", name: "x", status: "PENDING", language: "en" }),
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      client as unknown as ZernioClient,
    );
    return { svc, client };
  };

  it("lowercases a text header and its format", async () => {
    const { svc, client } = build();

    await svc.create("ws1", {
      name: "x",
      lang: "en",
      category: "UTILITY",
      headerType: "text",
      headerContent: "Your order",
      body: "Hi",
    });

    const sent = client.createWhatsAppTemplate.mock.calls[0][0];
    expect(sent.components[0]).toEqual({ type: "header", format: "text", text: "Your order" });
  });

  it("lowercases a media header format and passes the URL as header_handle", async () => {
    const { svc, client } = build();

    await svc.create("ws1", {
      name: "x",
      lang: "en",
      category: "UTILITY",
      headerType: "image",
      headerContent: "https://cdn.example/banner.png",
      body: "Hi",
    });

    const sent = client.createWhatsAppTemplate.mock.calls[0][0];
    expect(sent.components[0]).toEqual({
      type: "header",
      format: "image",
      example: { header_handle: ["https://cdn.example/banner.png"] },
    });
  });

  it("lowercases button types, which the UI supplies as QUICK_REPLY/URL", async () => {
    const { svc, client } = build();

    await svc.create("ws1", {
      name: "x",
      lang: "en",
      category: "UTILITY",
      body: "Hi",
      buttons: [
        { type: "QUICK_REPLY", text: "Thanks" },
        { type: "URL", text: "Track", url: "https://example.com" },
      ],
    });

    const sent = client.createWhatsAppTemplate.mock.calls[0][0];
    const buttons = sent.components.find((c: { type: string }) => c.type === "buttons");
    expect(buttons.buttons).toEqual([
      { type: "quick_reply", text: "Thanks" },
      { type: "url", text: "Track", url: "https://example.com" },
    ]);
  });
});

describe("TemplatesService.create — Meta requires sample values", () => {
  const build = () => {
    const prisma = {
      integration: { findFirst: jest.fn().mockResolvedValue({ pageId: "acc1" }) },
      template: { create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "t9", ...data })) },
    };
    const client = {
      createWhatsAppTemplate: jest
        .fn()
        .mockResolvedValue({ id: "m1", name: "x", status: "PENDING", language: "en" }),
    };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      client as unknown as ZernioClient,
    );
    return { svc, client };
  };

  const bodyOf = (client: { createWhatsAppTemplate: jest.Mock }) =>
    client.createWhatsAppTemplate.mock.calls[0][0].components.find(
      (c: { type: string }) => c.type === "body",
    );

  it("supplies one sample per body variable", async () => {
    // Live-verified 2026-08-28: submitting a body with {{1}} and NO
    // example.body_text comes straight back REJECTED from Meta.
    const { svc, client } = build();

    await svc.create("ws1", {
      name: "x",
      lang: "en",
      category: "UTILITY",
      body: "Hi {{1}}, your order {{2}} is ready.",
    });

    // Meta's shape is an array of arrays — one inner array per variable set.
    expect(bodyOf(client).example.body_text).toHaveLength(1);
    expect(bodyOf(client).example.body_text[0]).toHaveLength(2);
  });

  it("sends no example block when the body has no variables", async () => {
    const { svc, client } = build();

    await svc.create("ws1", {
      name: "x",
      lang: "en",
      category: "UTILITY",
      body: "hello sir how are you",
    });

    expect(bodyOf(client).example).toBeUndefined();
  });

  it("counts distinct placeholders, not repeats", async () => {
    const { svc, client } = build();

    await svc.create("ws1", {
      name: "x",
      lang: "en",
      category: "UTILITY",
      body: "Hi {{1}}, we will see you {{2}}. Bye {{1}}.",
    });

    expect(bodyOf(client).example.body_text[0]).toHaveLength(2);
  });

  it("prefers caller-supplied samples over generated ones", async () => {
    const { svc, client } = build();

    await svc.create("ws1", {
      name: "x",
      lang: "en",
      category: "UTILITY",
      body: "Hi {{1}}, order {{2}}",
      bodyExamples: ["Ashraf", "ORD-99"],
    });

    expect(bodyOf(client).example.body_text[0]).toEqual(["Ashraf", "ORD-99"]);
  });

  it("supplies a sample for a variable in a text header", async () => {
    const { svc, client } = build();

    await svc.create("ws1", {
      name: "x",
      lang: "en",
      category: "UTILITY",
      headerType: "text",
      headerContent: "Order {{1}}",
      body: "hello",
    });

    const header = client.createWhatsAppTemplate.mock.calls[0][0].components.find(
      (c: { type: string }) => c.type === "header",
    );
    expect(header.example.header_text).toHaveLength(1);
  });
});

describe("TemplatesService.list — surfaces Meta's rejection reason", () => {
  const build = (meta: Array<Record<string, unknown>>, local: Array<Record<string, unknown>> = []) => {
    const prisma = {
      integration: { findFirst: jest.fn().mockResolvedValue({ pageId: "acc1" }) },
      template: {
        findMany: jest.fn().mockResolvedValue(local),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new", ...data })),
      },
    };
    const client = { whatsappTemplates: jest.fn().mockResolvedValue(meta) };
    const svc = new TemplatesService(
      prisma as unknown as PrismaService,
      client as unknown as ZernioClient,
    );
    return { svc, prisma };
  };

  it("records why Meta rejected a template", async () => {
    // Without this the screen shows a bare "rejected" and the user has no idea
    // that, say, the variables had no sample values.
    const { svc } = build([
      {
        id: "meta-1",
        name: "invoice_due",
        language: "en",
        status: "REJECTED",
        category: "UTILITY",
        rejected_reason: "INVALID_FORMAT",
      },
    ]);

    const rows = await svc.list("ws1");

    expect(rows[0].status).toBe("rejected");
    expect(rows[0].metaRejectionReason).toBe("INVALID_FORMAT");
  });

  it("clears a stale reason once Meta approves", async () => {
    const { svc } = build(
      [
        {
          id: "meta-1",
          name: "invoice_due",
          language: "en",
          status: "APPROVED",
          category: "UTILITY",
        },
      ],
      [
        {
          id: "t1",
          name: "invoice_due",
          lang: "en",
          category: "UTILITY",
          status: "rejected",
          uses: 0,
          metaTemplateId: "meta-1",
          metaRejectionReason: "INVALID_FORMAT",
        },
      ],
    );

    const rows = await svc.list("ws1");

    expect(rows[0].status).toBe("approved");
    expect(rows[0].metaRejectionReason).toBeNull();
  });
});
