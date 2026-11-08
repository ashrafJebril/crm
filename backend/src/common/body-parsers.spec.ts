import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter, type NestExpressApplication } from "@nestjs/platform-express";
import { PassThrough } from "stream";
import { configureBodyParsers } from "./body-parsers";

@Module({})
class EmptyModule {}

type Layer = { handle: ((req: unknown, res: unknown, next: (err?: unknown) => void) => void) & { name: string } };

/** Feeds a body through the app's mounted jsonParser (no network listener). */
function parse(layer: Layer, body: string): Promise<{ err?: { status?: number }; req: Record<string, unknown> }> {
  const bytes = Buffer.from(body, "utf8");
  const req = Object.assign(new PassThrough(), {
    headers: { "content-type": "application/json", "content-length": String(bytes.length) },
    method: "POST",
    url: "/api/contacts/bulk",
  }) as unknown as Record<string, unknown>;
  return new Promise((resolve) => {
    layer.handle(req, {}, (err?: unknown) => resolve({ err: err as { status?: number } | undefined, req }));
    (req as unknown as PassThrough).end(bytes);
  });
}

describe("configureBodyParsers", () => {
  let app: NestExpressApplication;
  let layers: Layer[];

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(EmptyModule, new ExpressAdapter(), {
      rawBody: true,
      logger: false,
    });
    configureBodyParsers(app);
    await app.init();
    layers = app.getHttpAdapter().getInstance()._router.stack as Layer[];
  });

  afterAll(() => app.close());

  const jsonLayers = () => layers.filter((l) => l.handle?.name === "jsonParser");

  it("mounts exactly one JSON parser (Nest's 100kb default is skipped) and keeps urlencoded", () => {
    expect(jsonLayers()).toHaveLength(1);
    expect(layers.some((l) => l.handle?.name === "urlencodedParser")).toBe(true);
  });

  it("accepts a select-all sized body (10 000 ids) and still keeps the raw bytes for signature guards", async () => {
    const body = JSON.stringify({ op: "setOptOut", value: true, ids: Array.from({ length: 10_000 }, (_, i) => `cm${String(i).padStart(23, "x")}`) });
    expect(body.length).toBeGreaterThan(100 * 1024);
    const { err, req } = await parse(jsonLayers()[0], body);
    expect(err).toBeUndefined();
    expect((req.body as { ids: string[] }).ids).toHaveLength(10_000);
    expect(Buffer.isBuffer(req.rawBody)).toBe(true);
    expect((req.rawBody as Buffer).toString("utf8")).toBe(body);
  });

  it("still rejects bodies over 2mb with 413", async () => {
    const body = JSON.stringify({ blob: "x".repeat(2 * 1024 * 1024 + 10) });
    const { err } = await parse(jsonLayers()[0], body);
    expect(err?.status).toBe(413);
  });
});
