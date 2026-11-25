import { DEFAULT_LOST_REASONS, ensureDefaultLostReasons } from "./default-lost-reasons";

describe("ensureDefaultLostReasons", () => {
  const make = (count: number) => {
    const order: string[] = [];
    const tx: any = {
      $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...v: unknown[]) => {
        order.push("lock");
        tx.lockArgs = { sql: strings.join("?"), v };
      }),
      lostReason: {
        count: jest.fn(async () => { order.push("count"); return count; }),
        createMany: jest.fn(async () => { order.push("create"); }),
      },
    };
    const db: any = { ...tx, $transaction: jest.fn(async (fn: any) => fn(tx)) };
    return { db, tx, order };
  };

  it("locks per pipeline inside a transaction, then counts, then seeds", async () => {
    const { db, tx, order } = make(0);
    await expect(ensureDefaultLostReasons(db, "ws", "pl")).resolves.toBe(true);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["lock", "count", "create"]);
    expect(tx.lockArgs.sql).toContain("pg_advisory_xact_lock(hashtext('lost-reasons:'");
    expect(tx.lockArgs.v).toEqual(["pl"]);
    expect(tx.lostReason.createMany.mock.calls[0][0].data).toHaveLength(DEFAULT_LOST_REASONS.length);
  });

  it("does nothing when any reason (even archived) exists", async () => {
    const { db, tx } = make(1);
    await expect(ensureDefaultLostReasons(db, "ws", "pl")).resolves.toBe(false);
    expect(tx.lostReason.createMany).not.toHaveBeenCalled();
  });

  it("uses an existing transaction handle directly", async () => {
    const { tx } = make(0);
    await expect(ensureDefaultLostReasons(tx, "ws", "pl")).resolves.toBe(true);
  });
});
