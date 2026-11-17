import { Prisma } from "@prisma/client";
import { WalletService } from "./wallet.service";
import { WALLET_EMPTY } from "./billing-errors";

const WS = "ws_wallet";
const D = (v: string | number) => new Prisma.Decimal(v);

/**
 * An in-memory wallet with real interleaving: every delegate call yields to
 * the event loop first, so 20 parallel debits genuinely overlap. The
 * conditional decrement is atomic (one synchronous step, as one UPDATE is in
 * Postgres), a unique usage key throws P2002, and a transaction that throws
 * undoes exactly its own writes (no global snapshot).
 */
function makeWorld(start: string) {
  const db = {
    wallet: { id: "w1", workspaceId: WS, balanceJod: D(start) } as { id: string; workspaceId: string; balanceJod: Prisma.Decimal } | null,
    tx: [] as any[],
    usage: [] as any[],
  };
  let seq = 0;
  const tick = () => new Promise((r) => setImmediate(r));
  const delegates = (undo: Array<() => void> | null) => ({
    usageEvent: {
      findFirst: async ({ where }: any) => {
        await tick();
        return db.usage.find((u) => u.workspaceId === where.workspaceId && u.idempotencyKey === where.idempotencyKey) ?? null;
      },
      create: async ({ data }: any) => {
        await tick();
        if (db.usage.some((u) => u.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { id: `u${++seq}`, walletTxId: null, ...data };
        db.usage.push(row);
        undo?.push(() => db.usage.splice(db.usage.indexOf(row), 1));
        return row;
      },
      update: async ({ where, data }: any) => {
        await tick();
        const row = db.usage.find((u) => u.id === where.id);
        const prev = { ...row };
        Object.assign(row, data);
        undo?.push(() => Object.assign(row, prev));
        return row;
      },
    },
    adsWallet: {
      findFirst: async () => {
        await tick();
        return db.wallet ? { ...db.wallet } : null;
      },
      upsert: async ({ create }: any) => {
        await tick();
        if (!db.wallet) {
          db.wallet = { id: "w1", ...create };
          undo?.push(() => (db.wallet = null));
        }
        return db.wallet;
      },
      updateMany: async ({ where, data }: any) => {
        await tick();
        const w = db.wallet!;
        if (w.balanceJod.lessThan(where.balanceJod.gte)) return { count: 0 };
        const before = w.balanceJod;
        w.balanceJod = w.balanceJod.minus(data.balanceJod.decrement);
        undo?.push(() => (w.balanceJod = w.balanceJod.plus(before.minus(w.balanceJod))));
        return { count: 1 };
      },
    },
    adsWalletTransaction: {
      create: async ({ data }: any) => {
        await tick();
        const row = { id: `t${++seq}`, createdAt: new Date(), ...data };
        db.tx.push(row);
        undo?.push(() => db.tx.splice(db.tx.indexOf(row), 1));
        return row;
      },
      findMany: async () => [...db.tx].reverse(),
    },
  });
  const prisma = {
    ...delegates(null),
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const undo: Array<() => void> = [];
      try {
        return await fn(delegates(undo));
      } catch (e) {
        for (const u of undo.reverse()) u();
        throw e;
      }
    },
  };
  return { db, svc: new WalletService(prisma as never) };
}

const debit = (svc: WalletService, i: number, amount = "0.1") =>
  svc.debit(WS, { meter: "ai_reply", amountJod: amount, sourceKind: "message", sourceId: `m${i}` });

describe("WalletService (SP-28)", () => {
  it("wallet never goes negative under concurrent debits", async () => {
    const { db, svc } = makeWorld("1.0000");
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => debit(svc, i)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(10);
    expect(refused).toHaveLength(10);
    for (const r of refused) {
      expect(r.reason.getStatus()).toBe(402);
      expect(r.reason.getResponse()).toMatchObject({ statusCode: 402, code: WALLET_EMPTY });
    }
    expect(db.wallet!.balanceJod.toFixed(4)).toBe("0.0000");
    const sum = db.tx.reduce((a, t) => a.plus(t.amountJod), D(0));
    expect(sum.toFixed(4)).toBe("-1.0000");
    for (const t of db.tx) expect(t).toMatchObject({ type: "DEBIT", meter: "ai_reply", workspaceId: WS });
    // No usage for the refused ones; each charged one points at its ledger row.
    expect(db.usage).toHaveLength(10);
    for (const u of db.usage) expect(db.tx.some((t) => t.id === u.walletTxId)).toBe(true);
    expect(db.tx.every((t) => !t.balanceAfterJod.isNegative())).toBe(true);
  });

  it("debit is idempotent per idempotencyKey", async () => {
    const { db, svc } = makeWorld("1.0000");
    const first = await debit(svc, 1, "0.25");
    const again = await debit(svc, 1, "0.25");
    expect(first).toMatchObject({ replayed: false, balanceAfterJod: "0.7500" });
    expect(again).toEqual({ replayed: true, walletTxId: first.walletTxId, balanceAfterJod: "0.7500" });
    // Two concurrent deliveries of one source: one charge.
    const [a, b] = await Promise.all([debit(svc, 2, "0.25"), debit(svc, 2, "0.25")]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(db.tx).toHaveLength(2);
    expect(db.wallet!.balanceJod.toFixed(4)).toBe("0.5000");
  });

  it("refuses bad amounts; a refused debit leaves no ledger row and no usage", async () => {
    const { db, svc } = makeWorld("0.0500");
    for (const bad of ["0", "-1", "abc", "0.00001"]) {
      await expect(debit(svc, 9, bad)).rejects.toMatchObject({ response: { message: "billing.invalid_amount" } });
    }
    await expect(debit(svc, 3, "0.1")).rejects.toMatchObject({ response: { code: WALLET_EMPTY, balanceJod: "0.0500", requiredJod: "0.1000" } });
    expect(db.tx).toHaveLength(0);
    expect(db.usage).toHaveLength(0);
    expect(db.wallet!.balanceJod.toFixed(4)).toBe("0.0500");
  });

  it("balance and ledger read the one AdsWallet store; the facade never mints balance", async () => {
    const { svc } = makeWorld("2.0000");
    await debit(svc, 4, "0.5");
    expect((await svc.balance(WS)).toFixed(4)).toBe("1.5000");
    const page = await svc.ledger(WS);
    expect(page.items[0]).toMatchObject({ type: "DEBIT", meter: "ai_reply", amountJod: "-0.5000", balanceAfterJod: "1.5000" });
    expect(page.nextCursor).toBeNull();
    // AdsWalletService.credit stays reachable only from the ads Stripe webhook.
    expect((svc as unknown as Record<string, unknown>).credit).toBeUndefined();
  });
});
