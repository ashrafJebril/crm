import { TemplatesService } from "./templates.service";
import { makeFakePrisma } from "../channels/test-prisma";

const ch = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "whatsapp",
  provider: "zernio",
  externalId: `acc-${id}`,
  displayName: id,
  status: "active",
  isDefault: false,
  integrationId: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

describe("templates stay on the default WhatsApp number (R8)", () => {
  it("lists templates of the default Zernio WhatsApp channel's account", async () => {
    const prisma = makeFakePrisma({
      integration: [{ id: "int", workspaceId: "ws1", platform: "whatsapp", provider: "zernio", pageId: "acc-legacy" }],
      channel: [ch("A"), ch("B", { isDefault: true, updatedAt: new Date("2025-01-01") }), ch("OFF", { status: "disconnected", isDefault: false })],
    });
    const client = { whatsappTemplates: jest.fn(async () => []) };
    const svc = new TemplatesService(prisma, client as never);
    await svc.list("ws1");
    expect(client.whatsappTemplates).toHaveBeenCalledWith("acc-B");
  });

  it("falls back to the legacy Integration when no channel is mirrored yet", async () => {
    const prisma = makeFakePrisma({
      integration: [{ id: "int", workspaceId: "ws1", platform: "whatsapp", provider: "zernio", pageId: "acc-legacy" }],
    });
    const client = { whatsappTemplates: jest.fn(async () => []) };
    await new TemplatesService(prisma, client as never).list("ws1");
    expect(client.whatsappTemplates).toHaveBeenCalledWith("acc-legacy");
  });
});
