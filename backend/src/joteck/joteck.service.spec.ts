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
    expect(raw.workspace.update.mock.calls[0][0].data).toEqual({ plan: "Ultimate", enabledModules: ["inbox"], suspendedAt: null });
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
