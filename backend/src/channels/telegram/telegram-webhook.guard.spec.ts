import { createHash } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { secretMatchesHash, TelegramWebhookGuard } from "./telegram-webhook.guard";
import { makeFakePrisma } from "../test-prisma";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function ctx(channelId: string | undefined, headers: Record<string, unknown>) {
  const req: Record<string, unknown> = { params: { channelId }, headers };
  return { req, context: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext };
}

describe("TelegramWebhookGuard", () => {
  const prisma = makeFakePrisma({
    channel: [
      { id: "T1", workspaceId: "ws1", kind: "telegram", provider: "telegram", externalId: "1", displayName: "b", status: "error", isDefault: false, webhookSecretHash: sha("s3cret") },
    ],
  });
  prisma.raw = prisma;
  const guard = new TelegramWebhookGuard(prisma);

  it("attaches the channel for the handler (any non-disconnected status)", async () => {
    const { req, context } = ctx("T1", { "x-telegram-bot-api-secret-token": "s3cret" });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.telegramChannel).toMatchObject({ id: "T1" });
  });

  it("rejects a repeated header", async () => {
    const { context } = ctx("T1", { "x-telegram-bot-api-secret-token": ["s3cret", "s3cret"] });
    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 403 });
  });

  it("404 for a missing or oversized id without a lookup", async () => {
    prisma.channel.findFirst.mockClear();
    for (const id of [undefined, "x".repeat(200)]) {
      const { context } = ctx(id, { "x-telegram-bot-api-secret-token": "s3cret" });
      await expect(guard.canActivate(context)).rejects.toMatchObject({ status: 404 });
    }
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
  });

  it("secretMatchesHash is exact", () => {
    expect(secretMatchesHash("s3cret", sha("s3cret"))).toBe(true);
    expect(secretMatchesHash("s3cret ", sha("s3cret"))).toBe(false);
    expect(secretMatchesHash("s3cret", "zz")).toBe(false);
    expect(secretMatchesHash("", sha(""))).toBe(false);
    expect(secretMatchesHash("s3cret", null)).toBe(false);
  });
});
