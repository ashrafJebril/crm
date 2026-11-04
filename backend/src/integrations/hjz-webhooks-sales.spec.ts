import { HjzWebhooksService } from "./hjz-webhooks.service";
import type { HjzSaleWebhookDto } from "./hjz-webhooks.dto";

const body = (over: Partial<HjzSaleWebhookDto["sale"]> = {}): HjzSaleWebhookDto => ({
  event: "sale.completed",
  sale: {
    id: "sale-1",
    tenantId: "tenant-1",
    receiptNumber: "SAL-1042",
    total: "25.00",
    paid: "25.00",
    currency: "JOD",
    saleDate: "2026-11-03T10:00:00.000Z",
    branchName: "Abdoun",
    client: { id: "client-1", name: "Lina", phone: "962790000000" },
    items: [
      { name: "Haircut", quantity: 1, total: "15.00" },
      { name: "Beard trim", quantity: 2, total: "10.00" },
    ],
    ...over,
  },
});

describe("HjzWebhooksService.handleSale — sale.completed", () => {
  let prisma: {
    workspace: { findUnique: jest.Mock };
    contact: { findFirst: jest.Mock };
    workflowRun: { findFirst: jest.Mock };
  };
  let events: { emit: jest.Mock };
  let svc: HjzWebhooksService;

  beforeEach(() => {
    prisma = {
      workspace: { findUnique: jest.fn().mockResolvedValue({ id: "ws1" }) },
      contact: { findFirst: jest.fn().mockResolvedValue({ id: "c1", name: "Lina Haddad", phone: "962790000000" }) },
      workflowRun: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    events = { emit: jest.fn() };
    svc = new HjzWebhooksService(prisma as never, events as never);
  });

  it("starts sale_completed workflows with the contact and a one-line receipt", async () => {
    const res = await svc.handleSale(body());
    expect(res).toEqual({ ok: true, matched: true });
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({ where: { externalTenantId: "tenant-1" }, select: { id: true } });
    expect(events.emit).toHaveBeenCalledWith("workflow.trigger", {
      workspaceId: "ws1",
      triggerType: "sale_completed",
      payload: {
        contact: { id: "c1", name: "Lina Haddad", phone: "962790000000" },
        sale: {
          id: "sale-1",
          receiptNumber: "SAL-1042",
          total: "25.00",
          paid: "25.00",
          currency: "JOD",
          date: "2026-11-03T10:00:00.000Z",
          branch: "Abdoun",
          itemCount: 2,
          itemsText: "Haircut ×1 (15.00) · Beard trim ×2 (10.00)",
        },
      },
    });
  });

  it("matches the contact by HJZ client link first, then by phone", async () => {
    prisma.contact.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "c7", name: "L", phone: "962790000000" });
    await svc.handleSale(body());
    const wheres = prisma.contact.findFirst.mock.calls.map((c) => c[0].where);
    expect(wheres[0]).toEqual({ workspaceId: "ws1", hjzClientId: "client-1" });
    expect(wheres[2]).toMatchObject({ workspaceId: "ws1", phone: "962790000000" });
    expect(events.emit.mock.calls[0][1].payload.contact.id).toBe("c7");
  });

  it("ignores a sale it has already started workflows for (HJZ retries)", async () => {
    prisma.workflowRun.findFirst.mockResolvedValue({ id: "run-1" });
    const res = await svc.handleSale(body());
    expect(res).toEqual({ ok: true, matched: true, duplicate: true });
    expect(prisma.workflowRun.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "ws1", isTest: false, context: { path: ["trigger", "sale", "id"], equals: "sale-1" } },
      select: { id: true },
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("skips tenants with no CRM workspace instead of creating one", async () => {
    prisma.workspace.findUnique.mockResolvedValue(null);
    expect(await svc.handleSale(body())).toEqual({ ok: true, matched: false, reason: "unknown tenant" });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("skips sales whose customer isn't in the CRM", async () => {
    prisma.contact.findFirst.mockResolvedValue(null);
    expect(await svc.handleSale(body())).toEqual({ ok: true, matched: false, reason: "unknown client" });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("skips walk-in sales with no client", async () => {
    expect(await svc.handleSale(body({ client: null }))).toEqual({ ok: true, matched: false, reason: "no client" });
  });

  it("falls back to the sale number when there is no receipt number", async () => {
    await svc.handleSale(body({ receiptNumber: undefined, number: 1042 }));
    expect(events.emit.mock.calls[0][1].payload.sale.receiptNumber).toBe("1042");
  });

  it("keeps a long item list short enough for a WhatsApp template variable", async () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ name: `Service number ${i}`, quantity: 1, total: "1.00" }));
    await svc.handleSale(body({ items }));
    const text: string = events.emit.mock.calls[0][1].payload.sale.itemsText;
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text.endsWith("…")).toBe(true);
  });
});
