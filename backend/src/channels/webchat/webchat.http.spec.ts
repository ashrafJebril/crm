import "reflect-metadata";
import { INestApplication, Module, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PrismaService } from "../../prisma/prisma.service";
import { RealtimeGateway } from "../../realtime/realtime.gateway";
import { RealtimeService } from "../../realtime/realtime.service";
import { ChannelTransportRegistry } from "../channel-transport";
import { InboundSinkService } from "../inbound-sink.service";
import { makeFakePrisma } from "../test-prisma";
import { WebchatController } from "./webchat.controller";
import { WebchatService } from "./webchat.service";
import { WidgetOriginGuard } from "./widget-origin.guard";
import { WidgetRateLimitGuard, widgetRateLimiterProvider } from "./widget-rate-limit.guard";

/**
 * The widget routes behind the real HTTP stack: the `api` prefix and the
 * app's global ValidationPipe (whitelist + forbidNonWhitelisted, main.ts).
 * Local loopback only; the Prisma double replaces the database.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(40);

const prisma = makeFakePrisma({
  channel: [
    {
      id: "W1",
      workspaceId: "ws1",
      kind: "webchat",
      provider: "native",
      status: "active",
      displayName: "Shop",
      config: { allowedOrigins: ["https://shop.example"] },
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
  workspace: [{ id: "ws1", lang: "en" }],
} as never);
prisma.raw = prisma;

@Module({
  controllers: [WebchatController],
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: RealtimeGateway, useValue: { server: undefined } },
    RealtimeService,
    {
      provide: InboundSinkService,
      useFactory: (rt: RealtimeService) => new InboundSinkService(prisma, rt, { onInboundMessage: async () => {} } as never),
      inject: [RealtimeService],
    },
    ChannelTransportRegistry,
    WebchatService,
    WidgetOriginGuard,
    WidgetRateLimitGuard,
    widgetRateLimiterProvider,
  ],
})
class WidgetHttpModule {}

let app: INestApplication;
let base = "";

beforeAll(async () => {
  app = await NestFactory.create(WidgetHttpModule, { logger: false });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
}, 30_000);

afterAll(async () => {
  await app?.close();
});

describe("widget routes over HTTP", () => {
  it("I2: the hosted link opens with tracking params (fbclid, utm_*)", async () => {
    const r = await fetch(`${base}/api/chat/W1?fbclid=x&utm_source=y&lang=ar`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await r.text()).toContain('<html lang="ar" dir="rtl">');
  });

  it("the JSON routes stay strict about unknown keys", async () => {
    expect((await fetch(`${base}/api/widget/W1/config?x=1`)).status).toBe(400);
  });

  it("m5: the visitor token travels in X-Visitor-Token; as a query or body field it is refused", async () => {
    const sent = await fetch(`${base}/api/widget/W1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello" }),
    });
    expect(sent.status).toBe(200);
    const { visitorId, visitorToken } = (await sent.json()) as { visitorId: string; visitorToken: string };

    const ok = await fetch(`${base}/api/widget/W1/messages?visitorId=${visitorId}`, { headers: { "x-visitor-token": visitorToken } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { items: unknown[] }).items).toHaveLength(1);

    const q = await fetch(`${base}/api/widget/W1/messages?visitorId=${visitorId}&visitorToken=${visitorToken}`);
    expect(q.status).toBe(400);

    const again = await fetch(`${base}/api/widget/W1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-visitor-token": visitorToken },
      body: JSON.stringify({ body: "again", visitorId }),
    });
    expect(again.status).toBe(200);
    const inBody = await fetch(`${base}/api/widget/W1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "x", visitorId, visitorToken }),
    });
    expect(inBody.status).toBe(400);
  });
});
