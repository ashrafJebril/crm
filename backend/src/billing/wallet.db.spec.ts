/**
 * SP-28: `wallet never goes negative under concurrent debits` against real
 * Postgres. Skipped unless BILLING_TEST_DATABASE_URL points at a migrated
 * database (Task 4 runs it). Creates and deletes its own throwaway workspace,
 * so it is safe on a shared database; it never touches another row.
 */
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { WalletService } from "./wallet.service";
import { WALLET_EMPTY } from "./billing-errors";

const url = process.env.BILLING_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d("wallet against Postgres (SP-28)", () => {
  let prisma: PrismaService;
  let svc: WalletService;
  const tag = `zz-verify-wallet-${Date.now()}`;
  let ws = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    prisma = new PrismaService();
    svc = new WalletService(prisma);
    const w = await prisma.raw.workspace.create({ data: { name: tag, slug: tag } });
    ws = w.id;
    await prisma.raw.adsWallet.create({ data: { workspaceId: ws, balanceJod: new Prisma.Decimal("1.0000") } });
  }, 60_000);

  afterAll(async () => {
    if (ws) {
      await prisma.raw.usageEvent.deleteMany({ where: { workspaceId: ws } });
      await prisma.raw.adsWalletTransaction.deleteMany({ where: { workspaceId: ws } });
      await prisma.raw.adsWallet.deleteMany({ where: { workspaceId: ws } });
      await prisma.raw.workspace.delete({ where: { id: ws } });
    }
    await prisma?.onModuleDestroy();
  });

  it("wallet never goes negative under concurrent debits", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => svc.debit(ws, { meter: "ai_reply", amountJod: "0.1", sourceKind: "verify", sourceId: `${tag}-${i}` })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10);
    for (const r of results.filter((x) => x.status === "rejected") as PromiseRejectedResult[]) {
      expect(r.reason.getResponse()).toMatchObject({ code: WALLET_EMPTY });
    }
    const w = await prisma.raw.adsWallet.findUniqueOrThrow({ where: { workspaceId: ws } });
    expect(w.balanceJod.toFixed(4)).toBe("0.0000");
    const sum = await prisma.raw.adsWalletTransaction.aggregate({ where: { workspaceId: ws }, _sum: { amountJod: true } });
    expect(sum._sum.amountJod?.toFixed(4)).toBe("-1.0000");
    expect(await prisma.raw.usageEvent.count({ where: { workspaceId: ws } })).toBe(10);
  }, 60_000);

  it("the CHECK rejects a raw update below zero", async () => {
    await expect(
      prisma.raw.$executeRaw`UPDATE "AdsWallet" SET "balanceJod" = -1 WHERE "workspaceId" = ${ws}`,
    ).rejects.toThrow(/AdsWallet_balanceJod_non_negative|check constraint/i);
  });
});
