import { BadRequestException } from "@nestjs/common";
import { JoteckService } from "./joteck.service";

describe("JoteckService.patchWorkspace — Kewy package changes", () => {
  const row = {
    id: "ws-1", slug: "acme", name: "Acme", plan: "Ultimate", suspendedAt: null, externalTenantId: null,
    kewyWorkspaceId: "kw-1", lWorkspaceId: null, lang: "en", timezone: "Asia/Amman",
    enabledModules: ["inbox"], createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  let raw: any;
  let svc: JoteckService;

  beforeEach(() => {
    raw = { workspace: { update: jest.fn().mockResolvedValue(row), findUnique: jest.fn() } };
    svc = new JoteckService({ raw } as never, {} as never, { ensureQuietly: jest.fn() } as never);
  });

  it("stores the Kewy package name as the plan, with modules and status", async () => {
    await svc.patchWorkspace("ws-1", { plan: " Ultimate ", enabledModules: ["inbox"], active: true });
    // SP-28: Kewy's plan is also remembered as kewyPlan (the override's way back).
    expect(raw.workspace.update.mock.calls[0][0].data).toEqual({ plan: "Ultimate", kewyPlan: "Ultimate", enabledModules: ["inbox"], suspendedAt: null });
  });

  it("admin override survives a Kewy plan push (SP-28 R8)", async () => {
    raw.workspace.findUnique.mockResolvedValue({ planOverriddenAt: new Date("2026-11-01T00:00:00Z") });
    await svc.patchWorkspace("ws-1", { plan: "Basic" });
    const data = raw.workspace.update.mock.calls[0][0].data;
    expect(data).toEqual({ kewyPlan: "Basic" });
    expect(data).not.toHaveProperty("plan");
  });

  it("rejects an empty plan", async () => {
    await expect(svc.patchWorkspace("ws-1", { plan: "  " })).rejects.toThrow(BadRequestException);
    expect(raw.workspace.update).not.toHaveBeenCalled();
  });

  it("leaves the plan alone when Kewy doesn't send one", async () => {
    await svc.patchWorkspace("ws-1", { active: false });
    expect(raw.workspace.update.mock.calls[0][0].data).not.toHaveProperty("plan");
  });
});

describe("AdminService plan override (SP-28 R8)", () => {
  it("a super-admin plan sets the override; clear returns to Kewy's last plan", async () => {
    const { AdminService } = await import("../admin/admin.service");
    const db: any = { id: "ws-1", plan: "Ultimate", kewyPlan: "Ultimate", planOverriddenAt: null };
    const raw = {
      workspace: {
        findUnique: jest.fn(async () => ({ ...db })),
        update: jest.fn(async ({ data }: any) => Object.assign(db, data)),
      },
    };
    const plans = { invalidate: jest.fn() };
    const svc = new AdminService({ raw } as never, {} as never, {} as never, plans as never);
    (svc as any).requireWorkspace = jest.fn(async () => db);
    await svc.updateWorkspace("ws-1", { plan: "pro" } as never);
    expect(db.plan).toBe("pro");
    expect(db.planOverriddenAt).toBeInstanceOf(Date);
    expect(plans.invalidate).toHaveBeenCalledWith("ws-1");
    // Kewy pushes meanwhile: remembered, not applied.
    const joteck = new JoteckService({ raw } as never, {} as never, { ensureQuietly: jest.fn() } as never);
    raw.workspace.update.mockImplementationOnce(async ({ data }: any) => ({ ...Object.assign(db, data), createdAt: new Date(), enabledModules: [] }));
    await joteck.patchWorkspace("ws-1", { plan: "Basic" });
    expect(db).toMatchObject({ plan: "pro", kewyPlan: "Basic" });
    // Clear: back to Kewy's plan.
    await svc.clearPlanOverride("ws-1");
    expect(db).toMatchObject({ plan: "Basic", planOverriddenAt: null });
    // A name-only update does not set the override.
    await svc.updateWorkspace("ws-1", { name: "Acme 2" } as never);
    expect(db.planOverriddenAt).toBeNull();
  });
});

