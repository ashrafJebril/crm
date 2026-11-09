import { Logger } from "@nestjs/common";
import { toChannelDto } from "./channel-dto";
import { redactUrl } from "../common/redact-url";
import { ChannelsService } from "./channels.service";
import { ChannelTransportRegistry } from "./channel-transport";
import { makeFakePrisma } from "./test-prisma";

const TOKEN = "123456:AAH-super-secret-bot-token";
const ACCESS = "EAAG-meta-access-token-xyz";

const secretRow = () => ({
  id: "ch1",
  workspaceId: "ws1",
  kind: "telegram",
  provider: "telegram",
  externalId: "123456",
  displayName: "Bot",
  phoneNumber: null,
  status: "active",
  statusReason: null,
  health: null,
  isDefault: true,
  config: {
    botUsername: "shop_bot",
    accessToken: ACCESS,
    botToken: TOKEN,
    verifyToken: "vt-1",
    allowedOrigins: ["https://shop.example"],
  },
  secretsEnc: `{"botToken":"${TOKEN}"}`,
  webhookSecretHash: "f".repeat(64),
  integrationId: "int-1",
  lastInboundAt: null,
  disconnectedAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
});

const FORBIDDEN = [/"secretsEnc"/, /webhookSecretHash/, /accessToken/, /botToken/, /verifyToken/, /integrationId/];

function assertClean(json: string) {
  for (const re of FORBIDDEN) expect(json).not.toMatch(re);
  expect(json).not.toContain(TOKEN);
  expect(json).not.toContain(ACCESS);
  expect(json).not.toContain("int-1");
  expect(json).not.toContain("f".repeat(64));
}

describe("channel DTOs and logs never contain secrets", () => {
  it("toChannelDto whitelists fields and the config subset", () => {
    const dto = toChannelDto(secretRow());
    assertClean(JSON.stringify(dto));
    expect(dto).toEqual({
      id: "ch1",
      kind: "telegram",
      provider: "telegram",
      externalId: "123456",
      displayName: "Bot",
      phoneNumber: null,
      status: "active",
      statusReason: null,
      isDefault: true,
      config: { botUsername: "shop_bot", allowedOrigins: ["https://shop.example"] },
      lastInboundAt: null,
      createdAt: new Date("2026-01-01"),
    });
  });

  it("every /channels service response is secret-free", async () => {
    const prisma = makeFakePrisma({ channel: [secretRow()], workspace: [{ id: "ws1", plan: "free" }] });
    const svc = new ChannelsService(prisma, new ChannelTransportRegistry(), {
      emitToWorkspace: jest.fn(),
    } as never);
    const out = [
      await svc.list("ws1"),
      await svc.get("ws1", "ch1"),
      await svc.update("ws1", "ch1", { displayName: "Renamed" }),
      await svc.limits("ws1", true),
      await svc.disconnect("ws1", "ch1"),
    ];
    assertClean(JSON.stringify(out));
  });

  it("redactUrl masks a Telegram bot token in the path", () => {
    const url = `https://api.telegram.org/bot${TOKEN}/setWebhook?url=https%3A%2F%2Fx`;
    const red = redactUrl(url);
    expect(red).not.toContain(TOKEN);
    expect(red).toContain("/bot***/setWebhook");
    // malformed input still scrubbed
    expect(redactUrl(`api.telegram.org/bot${TOKEN}/getMe`)).not.toContain(TOKEN);
  });

  it("an unreadable secretsEnc is never echoed into a log", async () => {
    const { credentialsFor } = await import("./channel-credentials");
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const prisma = makeFakePrisma();
    const creds = await credentialsFor(prisma, { ...secretRow(), integrationId: null, secretsEnc: `not-json ${TOKEN}` });
    expect(creds).toEqual({ externalId: "123456" });
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(TOKEN);
    warn.mockRestore();
  });
});
