import "reflect-metadata";
import { createHash } from "node:crypto";
import { GUARDS_METADATA, HTTP_CODE_METADATA } from "@nestjs/common/constants";
import type { ExecutionContext } from "@nestjs/common";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";
import { ROUTE_PERMISSIONS, routesOf } from "../../permissions/permission-map";
import { TelegramController } from "./telegram.controller";
import { TelegramWebhookGuard } from "./telegram-webhook.guard";
import { TelegramService } from "./telegram.service";
import { ChannelTransportRegistry } from "../channel-transport";
import { InboundSinkService } from "../inbound-sink.service";
import { channelErrorKey } from "../channel-errors";
import { makeFakePrisma } from "../test-prisma";

const SECRET = "a".repeat(64);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const tg = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "ws1",
  kind: "telegram",
  provider: "telegram",
  externalId: "987654",
  displayName: "Bot",
  status: "active",
  isDefault: true,
  integrationId: null,
  config: { botUsername: "b" },
  secretsEnc: JSON.stringify({ botToken: "987654:AAF-secret_tok" }),
  webhookSecretHash: sha(SECRET),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function build() {
  const prisma = makeFakePrisma({
    channel: [
      tg("T1"),
      tg("T2", { status: "disconnected" }),
      tg("T3", { webhookSecretHash: null }),
      tg("W1", { kind: "webchat", provider: "native", externalId: null }),
    ],
  });
  prisma.raw = prisma;
  const realtime = { emitToWorkspace: jest.fn() };
  const sink = new InboundSinkService(prisma, realtime as never, { onInboundMessage: jest.fn(async () => {}) } as never);
  const client = { getFile: jest.fn(), downloadFile: jest.fn() };
  const svc = new TelegramService(prisma, client as never, sink, new ChannelTransportRegistry(), realtime as never, undefined);
  const guard = new TelegramWebhookGuard(prisma);
  const ctrl = new TelegramController(svc);
  return { prisma, guard, ctrl };
}

function ctx(channelId: string, headers: Record<string, unknown> = {}) {
  const req: Record<string, unknown> = { params: { channelId }, headers };
  const context = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  return { req, context };
}

/** The Nest pipeline for the public webhook: guard, then handler. Returns
 *  [status, body]. */
async function post(b: ReturnType<typeof build>, channelId: string, header: string | undefined, body: unknown) {
  const { req, context } = ctx(channelId, header === undefined ? {} : { "x-telegram-bot-api-secret-token": header });
  try {
    await b.guard.canActivate(context);
  } catch (e) {
    return [(e as { getStatus(): number }).getStatus(), e] as const;
  }
  const out = await b.ctrl.webhook(req as never, body);
  return [200, out] as const;
}

const update = (message_id = 1, update_id = 100) => ({
  update_id,
  message: {
    message_id,
    date: 1_762_675_200,
    chat: { id: 555, type: "private" },
    from: { id: 555, is_bot: false, first_name: "Sara" },
    text: "hi",
  },
});

describe("telegram webhook secret validated", () => {
  it("403 for a missing header", async () => {
    const b = build();
    const [status, err] = await post(b, "T1", undefined, update());
    expect(status).toBe(403);
    expect(channelErrorKey(err)).toBe("channels.webhook_forbidden");
    expect(b.prisma.db.message).toHaveLength(0);
  });

  it("403 for a wrong header (including a different-length one)", async () => {
    const b = build();
    expect((await post(b, "T1", "b".repeat(64), update()))[0]).toBe(403);
    expect((await post(b, "T1", "short", update()))[0]).toBe(403);
    expect((await post(b, "T1", sha(SECRET), update()))[0]).toBe(403); // the stored hash itself is not the secret
    expect(b.prisma.db.message).toHaveLength(0);
  });

  it("403 when no hash is stored (fails closed)", async () => {
    const b = build();
    expect((await post(b, "T3", SECRET, update()))[0]).toBe(403);
  });

  it("200 {ok:true} for the right header, with exactly one message ingested", async () => {
    const b = build();
    const [status, body] = await post(b, "T1", SECRET, update());
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(b.prisma.db.message).toHaveLength(1);
    expect(b.prisma.db.message[0]).toMatchObject({ body: "hi", metaMessageId: "tg:T1:555:1" });
  });

  it("404 for an unknown, disconnected or non-telegram channel", async () => {
    const b = build();
    for (const id of ["nope", "T2", "W1"]) {
      const [status, err] = await post(b, id, SECRET, update());
      expect(status).toBe(404);
      expect(channelErrorKey(err)).toBe("channels.not_found");
    }
    expect(b.prisma.db.message).toHaveLength(0);
  });

  it("a duplicate message_id is ingested once (Telegram redelivery)", async () => {
    const b = build();
    await post(b, "T1", SECRET, update(7, 100));
    const [status] = await post(b, "T1", SECRET, update(7, 100));
    expect(status).toBe(200);
    expect(b.prisma.db.message).toHaveLength(1);
    expect(b.prisma.db.conversation).toHaveLength(1);
  });

  it("is @Public(), guarded by TelegramWebhookGuard and answers 200", () => {
    const handler = TelegramController.prototype.webhook;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([TelegramWebhookGuard]);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });
});

describe("TelegramController routes", () => {
  it("maps every route with its permission; only the webhook is public", () => {
    const routes = routesOf(TelegramController);
    expect(Object.fromEntries(routes.map((r) => [r.key, ROUTE_PERMISSIONS[r.key]]))).toEqual({
      "POST /channels/telegram": "channels.create",
      "POST /webhooks/telegram/:channelId": "public",
    });
    const connect = TelegramController.prototype.connect;
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, connect)).toBeUndefined();
    expect(ROUTE_PERMISSIONS["POST /channels/:id/reconnect"]).toBe("channels.update");
  });

  it("connect passes the workspace and body to provision", async () => {
    const svc = { provision: jest.fn(async () => ({ id: "T" })) };
    const ctrl = new TelegramController(svc as never);
    await ctrl.connect("ws1", { botToken: "1:x" });
    expect(svc.provision).toHaveBeenCalledWith("ws1", { botToken: "1:x" });
  });
});
