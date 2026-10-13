import "reflect-metadata";
import { ForbiddenException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { TiremallWebhooksService } from "./tiremall-webhooks.service";
import { TiremallCustomersWebhookDto } from "./tiremall-webhooks.dto";

function makeSvc() {
  const prisma = {
    workspace: { upsert: jest.fn().mockResolvedValue({ id: "ws1" }), findUnique: jest.fn().mockResolvedValue(null) },
    contact: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  };
  return { prisma, svc: new TiremallWebhooksService(prisma as any) };
}

describe("TiremallWebhooksService.verifySecret", () => {
  afterEach(() => delete process.env.TIREMALL_WEBHOOK_SECRET);

  it("403 when secret unset", () => {
    const { svc } = makeSvc();
    expect(() => svc.verifySecret("x")).toThrow(ForbiddenException);
  });
  it("403 on wrong and different-length secret", () => {
    process.env.TIREMALL_WEBHOOK_SECRET = "abcdef";
    const { svc } = makeSvc();
    expect(() => svc.verifySecret("abcdeg")).toThrow(ForbiddenException);
    expect(() => svc.verifySecret("abc")).toThrow(ForbiddenException);
    expect(() => svc.verifySecret(undefined)).toThrow(ForbiddenException);
  });
  it("passes on correct secret", () => {
    process.env.TIREMALL_WEBHOOK_SECRET = "abcdef";
    const { svc } = makeSvc();
    expect(() => svc.verifySecret("abcdef")).not.toThrow();
  });
});

describe("TiremallWebhooksService.handle", () => {
  it("upserts customers (create new, update existing)", async () => {
    const { svc, prisma } = makeSvc();
    prisma.contact.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "c2" });
    const res = await svc.handle({
      event: "customer.upserted",
      customers: [
        { id: "1", name: "A", phone: "07", city: "Baghdad", totalSpent: 1234567.4 },
        { id: "2", name: "B" },
      ],
    } as any);
    expect(res).toEqual({ ok: true, processed: 2 });
    expect(prisma.workspace.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.workspace.upsert.mock.calls[0][0].where).toEqual({ tiremallTenantId: "tiremall" });
    expect(prisma.contact.findUnique.mock.calls[0][0].where).toEqual({
      workspaceId_externalSource_externalId: { workspaceId: "ws1", externalSource: "tiremall", externalId: "1" },
    });
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "ws1", externalSource: "tiremall", externalId: "1", name: "A", phone: "07",
        industry: "Baghdad", lifecycle: "customer", source: "tiremall", value: "IQD 1,234,567", lastSeen: "now",
      },
    });
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: "c2" },
      data: {
        workspaceId: "ws1", externalSource: "tiremall", externalId: "2", name: "B", phone: null,
        industry: "—", lifecycle: "customer", source: "tiremall", value: null, lastSeen: "now",
      },
    });
  });

  it("customer.deleted churns existing, skips missing", async () => {
    const { svc, prisma } = makeSvc();
    prisma.contact.findUnique.mockResolvedValueOnce({ id: "c1" }).mockResolvedValueOnce(null);
    const res = await svc.handle({
      event: "customer.deleted",
      customers: [{ id: "1", name: "A" }, { id: "2", name: "B" }],
    } as any);
    expect(res).toEqual({ ok: true, processed: 2 });
    expect(prisma.contact.update).toHaveBeenCalledTimes(1);
    expect(prisma.contact.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { lifecycle: "churned" } });
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });
});

describe("TiremallCustomersWebhookDto", () => {
  const check = (o: unknown) => validate(plainToInstance(TiremallCustomersWebhookDto, o as object));
  const item = (i: number) => ({ id: String(i), name: "n" });

  it("accepts valid", async () => {
    expect(await check({ event: "customer.upserted", customers: [item(1), { ...item(2), phone: null, city: null }] })).toHaveLength(0);
  });
  it("rejects empty customers", async () => {
    expect((await check({ event: "customer.upserted", customers: [] })).length).toBeGreaterThan(0);
  });
  it("rejects 501 items", async () => {
    const customers = Array.from({ length: 501 }, (_, i) => item(i));
    expect((await check({ event: "customer.upserted", customers })).length).toBeGreaterThan(0);
  });
  it("rejects unknown event", async () => {
    expect((await check({ event: "nope", customers: [item(1)] })).length).toBeGreaterThan(0);
  });
});
