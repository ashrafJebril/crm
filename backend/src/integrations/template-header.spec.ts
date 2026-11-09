import { BadRequestException, NotFoundException } from "@nestjs/common";
import { WhatsAppService } from "./whatsapp.service";
import { ZernioService } from "./zernio.service";
import { resolveTemplateHeader } from "./template-header";

function deps(o: { headerType?: string | null; tpl?: boolean; mime?: string; foreign?: boolean } = {}) {
  const prisma = {
    template: {
      findFirst: jest.fn(async () =>
        o.tpl === false ? null : { name: "promo", headerType: o.headerType === undefined ? "image" : o.headerType },
      ),
    },
  };
  const media = {
    get: jest.fn(async (ws: string, id: string) => {
      if (o.foreign) throw new NotFoundException("Media not found");
      return { id, workspaceId: ws, mimeType: o.mime ?? "image/png" };
    }),
    resolveExternalUrl: jest.fn(async () => "https://cdn.example/m.png"),
  };
  return { prisma, media };
}

describe("resolveTemplateHeader", () => {
  it("returns undefined when no header is requested", async () => {
    const d = deps();
    expect(await resolveTemplateHeader(d as never, "ws", "promo", undefined)).toBeUndefined();
    expect(await resolveTemplateHeader(d as never, "ws", "promo", {})).toBeUndefined();
  });

  it("builds an image header component from a library media id", async () => {
    const d = deps();
    const r = await resolveTemplateHeader(d as never, "ws", "promo", { mediaId: "m1" });
    expect(r).toEqual({
      component: { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example/m.png" } }] },
      attach: "m1",
    });
    expect(d.media.get).toHaveBeenCalledWith("ws", "m1");
  });

  it("builds video and document headers", async () => {
    const v = await resolveTemplateHeader(deps({ headerType: "video", mime: "video/mp4" }) as never, "ws", "promo", { mediaId: "m" });
    expect((v!.component.parameters[0] as any).type).toBe("video");
    const doc = await resolveTemplateHeader(deps({ headerType: "document", mime: "application/pdf" }) as never, "ws", "promo", { mediaId: "m" });
    expect((doc!.component.parameters[0] as any).type).toBe("document");
  });

  it("media from another workspace -> 404", async () => {
    await expect(
      resolveTemplateHeader(deps({ foreign: true }) as never, "ws", "promo", { mediaId: "other" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("mime not matching the header type -> 400 templates.header_media_mismatch", async () => {
    const d = deps({ headerType: "image", mime: "video/mp4" });
    await expect(resolveTemplateHeader(d as never, "ws", "promo", { mediaId: "m" })).rejects.toMatchObject({
      message: "templates.header_media_mismatch",
    });
    await expect(resolveTemplateHeader(d as never, "ws", "promo", { mediaId: "m" })).rejects.toBeInstanceOf(BadRequestException);
    // a text header cannot take media either
    await expect(
      resolveTemplateHeader(deps({ headerType: "text" }) as never, "ws", "promo", { mediaId: "m" }),
    ).rejects.toMatchObject({ message: "templates.header_media_mismatch" });
  });

  it("without a local template the media type is inferred from the mime; unsupported mimes are refused", async () => {
    const ok = await resolveTemplateHeader(deps({ tpl: false, mime: "image/jpeg" }) as never, "ws", "promo", { mediaId: "m" });
    expect((ok!.component.parameters[0] as any).type).toBe("image");
    await expect(
      resolveTemplateHeader(deps({ tpl: false, mime: "text/csv" }) as never, "ws", "promo", { mediaId: "m" }),
    ).rejects.toMatchObject({ message: "templates.header_media_mismatch" });
  });

  it("text header params become text parameters; refused for media templates", async () => {
    const r = await resolveTemplateHeader(deps({ headerType: "text" }) as never, "ws", "promo", { params: ["Ali"] });
    expect(r!.component).toEqual({ type: "header", parameters: [{ type: "text", text: "Ali" }] });
    expect(r!.attach).toBeUndefined();
    await expect(
      resolveTemplateHeader(deps({ headerType: "image" }) as never, "ws", "promo", { params: ["x"] }),
    ).rejects.toMatchObject({ message: "templates.header_media_mismatch" });
  });
});

describe("template send with header", () => {
  const header = { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example/m.png" } }] };

  it("WhatsApp: header component goes before the body component and the media is attached to the stored message", async () => {
    const prisma: any = {
      integration: { findFirst: jest.fn() },
      conversation: {
        findFirst: jest.fn(async () => ({ id: "c1", channel: "whatsapp", contact: { externalId: "962790000000" } })),
        update: jest.fn(async () => ({})),
      },
      message: { create: jest.fn(async () => ({})) },
      template: { findFirst: jest.fn(async () => ({ headerType: "image" })) },
    };
    const media = {
      get: jest.fn(async () => ({ mimeType: "image/png" })),
      resolveExternalUrl: jest.fn(async () => "https://cdn.example/m.png"),
    };
    const svc = new WhatsAppService(prisma, { emitToWorkspace: jest.fn() } as never, media as never, {} as never, {} as never);
    jest.spyOn(svc as any, "requireToken").mockResolvedValue({ token: "t", phoneNumberId: "pn" });
    const fetchJson = jest.spyOn(svc as any, "fetchJson").mockResolvedValue({ messages: [{ id: "wamid.1" }] });
    await svc.sendTemplateInConversation("ws", "c1", "promo", "en", ["Ali"], { mediaId: "m1" });
    const body = JSON.parse((fetchJson.mock.calls[0] as any)[1].body);
    expect(body.template.components.map((c: any) => c.type)).toEqual(["header", "body"]);
    expect(body.template.components[0]).toEqual(header);
    expect((prisma.message.create.mock.calls[0] as any)[0].data.attach).toBe("m1");
  });

  it("WhatsApp: a mismatching header is rejected before anything is sent", async () => {
    const prisma: any = {
      conversation: { findFirst: jest.fn(async () => ({ id: "c1", channel: "whatsapp", contact: { externalId: "9" } })) },
      template: { findFirst: jest.fn(async () => ({ headerType: "image" })) },
    };
    const media = { get: jest.fn(async () => ({ mimeType: "video/mp4" })), resolveExternalUrl: jest.fn() };
    const svc = new WhatsAppService(prisma, {} as never, media as never, {} as never, {} as never);
    jest.spyOn(svc as any, "requireToken").mockResolvedValue({ token: "t", phoneNumberId: "pn" });
    const fetchJson = jest.spyOn(svc as any, "fetchJson");
    await expect(svc.sendTemplateInConversation("ws", "c1", "promo", "en", [], { mediaId: "m1" })).rejects.toMatchObject({
      message: "templates.header_media_mismatch",
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("Zernio: forwards header then body components", async () => {
    const prisma: any = {
      conversation: {
        findFirst: jest.fn(async () => ({ id: "c1", channel: "whatsapp", contactId: "ct", contact: {} })),
        update: jest.fn(async () => ({})),
      },
      message: { create: jest.fn(async () => ({})) },
      template: { findFirst: jest.fn(async () => ({ headerType: "image" })) },
    };
    const media = {
      get: jest.fn(async () => ({ mimeType: "image/png" })),
      resolveExternalUrl: jest.fn(async () => "https://cdn.example/m.png"),
    };
    const client = { sendTemplateMessage: jest.fn(async () => ({ id: "zm1" })) };
    const svc = new ZernioService(
      prisma, { emitToWorkspace: jest.fn() } as never, media as never, client as never,
      { onOutboundReply: jest.fn() } as never, { enabled: false } as never, {} as never,
    );
    jest.spyOn(svc as any, "resolveZernioTarget").mockResolvedValue({ accountId: "a", zernioConvId: "z" });
    await svc.sendTemplateInDbConversation("ws", "c1", "promo", "en", ["Ali"], { mediaId: "m1" });
    const tpl = (client.sendTemplateMessage.mock.calls[0] as any)[2];
    expect(tpl.components.map((c: any) => c.type)).toEqual(["header", "body"]);
    expect(tpl.components[0]).toEqual(header);
    expect((prisma.message.create.mock.calls[0] as any)[0].data.attach).toBe("m1");
  });
});
