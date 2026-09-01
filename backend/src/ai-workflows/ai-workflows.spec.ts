import { HttpException, ValidationPipe } from "@nestjs/common";
import { AiWorkflowsClient } from "./ai-workflows.client";
import { AiWorkflowsService } from "./ai-workflows.service";
import { WorkflowDto } from "./ai-workflows.controller";

const WORKFLOW = {
  name: "Booking confirmation",
  enabled: false,
  trigger: "BOOKING_CREATED",
  conditions: [],
  actions: [{ type: "CUSTOMER_EMAIL", subject: "Confirmed", body: "Hi {{customer.name}}" }],
};

describe("AI workflows tenant-scoped proxy", () => {
  const previousFetch = global.fetch;
  afterEach(() => {
    global.fetch = previousFetch;
    delete process.env.KEWY_AI_URL;
    delete process.env.KEWY_AI_ADMIN_SECRET;
  });

  it("stamps tenant in the upstream path and keeps the admin secret server-side", async () => {
    process.env.KEWY_AI_URL = "http://kewy.test";
    process.env.KEWY_AI_ADMIN_SECRET = "server-only";
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ workflows: [], workflowKillSwitch: true }),
    })) as any;
    global.fetch = fetchSpy;

    await new AiWorkflowsClient().list("tenant-from-session");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://kewy.test/api/v1/admin/tenants/tenant-from-session/workflows");
    expect(init.headers["x-kewy-admin-secret"]).toBe("server-only");
    expect(init.body).toBeUndefined();
  });

  it("rejects a legacy raw workflow array instead of hiding upstream contract drift", async () => {
    process.env.KEWY_AI_URL = "http://kewy.test";
    process.env.KEWY_AI_ADMIN_SECRET = "server-only";
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]),
    })) as any;

    await expect(new AiWorkflowsClient().list("tenant-1")).rejects.toMatchObject({
      status: 502,
      response: { code: "AI_WORKFLOW_INVALID_RESPONSE" },
    });
  });

  it("requires lastRun on every workflow response", async () => {
    process.env.KEWY_AI_URL = "http://kewy.test";
    process.env.KEWY_AI_ADMIN_SECRET = "server-only";
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        workflowKillSwitch: false,
        workflows: [{ id: "wf-1", ...WORKFLOW }],
      }),
    })) as any;

    await expect(new AiWorkflowsClient().list("tenant-1")).rejects.toMatchObject({
      status: 502,
      response: { code: "AI_WORKFLOW_INVALID_RESPONSE" },
    });
  });

  it("rejects the legacy kill-switch response field", async () => {
    process.env.KEWY_AI_URL = "http://kewy.test";
    process.env.KEWY_AI_ADMIN_SECRET = "server-only";
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ tenantId: "tenant-1", workflowKillSwitch: true, enabled: true }),
    })) as any;

    await expect(new AiWorkflowsClient().setKillSwitch("tenant-1", true)).rejects.toMatchObject({
      status: 502,
      response: { code: "AI_WORKFLOW_INVALID_RESPONSE" },
    });
  });

  it("rejects a legacy raw run array instead of hiding upstream contract drift", async () => {
    process.env.KEWY_AI_URL = "http://kewy.test";
    process.env.KEWY_AI_ADMIN_SECRET = "server-only";
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([]),
    })) as any;

    await expect(new AiWorkflowsClient().listRuns("tenant-1")).rejects.toMatchObject({
      status: 502,
      response: { code: "AI_WORKFLOW_INVALID_RESPONSE" },
    });
  });

  it("requires flattened workflowName, event, bookingId, and typed actions on runs", async () => {
    process.env.KEWY_AI_URL = "http://kewy.test";
    process.env.KEWY_AI_ADMIN_SECRET = "server-only";
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        runs: [{ id: "run-1", status: "COMPLETED", createdAt: "2026-09-01T10:00:00.000Z", workflow: { name: "Legacy nested" }, actions: [] }],
      }),
    })) as any;

    await expect(new AiWorkflowsClient().listRuns("tenant-1")).rejects.toMatchObject({
      status: 502,
      response: { code: "AI_WORKFLOW_INVALID_RESPONSE" },
    });
  });

  it("pins the explicit upstream list, runs, and kill-switch response shapes", async () => {
    process.env.KEWY_AI_URL = "http://kewy.test";
    process.env.KEWY_AI_ADMIN_SECRET = "server-only";
    const workflowView = {
      workflows: [{ id: "wf-1", ...WORKFLOW, lastRun: { status: "COMPLETED", createdAt: "2026-09-01T10:00:00.000Z" } }],
      workflowKillSwitch: false,
    };
    const runsView = {
      runs: [{
        id: "run-1",
        workflowName: "Booking confirmation",
        event: "booking.created",
        bookingId: "booking-1",
        status: "PARTIAL_FAILED",
        createdAt: "2026-09-01T10:00:00.000Z",
        actions: [{ id: "action-1", type: "CUSTOMER_EMAIL", status: "BLOCKED_BY_TEST_ALLOWLIST", recipient: "sara@example.com", providerMessageId: null, error: null }],
        error: null,
      }],
    };
    const killSwitchView = { tenantId: "tenant-1", workflowKillSwitch: true };
    const fetchSpy = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(workflowView) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(runsView) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify(killSwitchView) });
    global.fetch = fetchSpy as any;
    const client = new AiWorkflowsClient();

    expect(await client.list("tenant-1")).toEqual(workflowView);
    expect(await client.listRuns("tenant-1")).toEqual(runsView);
    expect(await client.setKillSwitch("tenant-1", true)).toEqual(killSwitchView);
    expect(JSON.parse(fetchSpy.mock.calls[2][1].body)).toEqual({ enabled: true });
  });

  it("service never accepts a browser tenantId and forwards the session workspace", async () => {
    const client = {
      create: jest.fn(async () => ({ id: "wf-1", ...WORKFLOW })),
    } as any;
    const service = new AiWorkflowsService(client);
    await service.create("workspace-from-session", WORKFLOW as any);
    expect(client.create).toHaveBeenCalledWith("workspace-from-session", WORKFLOW);
  });

  it("redacts upstream 5xx bodies", async () => {
    process.env.KEWY_AI_URL = "http://kewy.test";
    process.env.KEWY_AI_ADMIN_SECRET = "server-only";
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "postgres://secret@db/tenant-other stack trace",
    })) as any;
    await expect(new AiWorkflowsClient().list("tenant-1")).rejects.toMatchObject({
      status: 502,
      response: expect.not.stringContaining("postgres"),
    } as Partial<HttpException> & { status: number });
  });

  it("passes actionable upstream validation messages through as 400", async () => {
    process.env.KEWY_AI_URL = "http://kewy.test";
    process.env.KEWY_AI_ADMIN_SECRET = "server-only";
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ message: "Unknown template variable {{secret}}" }),
    })) as any;
    await expect(new AiWorkflowsClient().create("tenant-1", WORKFLOW as any)).rejects.toMatchObject({
      status: 400,
      response: { message: "Unknown template variable {{secret}}" },
    });
  });

  it("rejects a browser-supplied tenantId at the DTO boundary", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await expect(pipe.transform({ ...WORKFLOW, tenantId: "other-tenant" }, { type: "body", metatype: WorkflowDto })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects malformed staff recipients before calling upstream", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await expect(pipe.transform({ ...WORKFLOW, actions: [{ type: "STAFF_EMAIL", recipients: ["wrong"], subject: "Booked", body: "Body" }] }, { type: "body", metatype: WorkflowDto })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects empty service condition values", async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    await expect(pipe.transform({ ...WORKFLOW, conditions: [{ field: "services.ids", op: "CONTAINS_ANY", value: [] }] }, { type: "body", metatype: WorkflowDto })).rejects.toMatchObject({ status: 400 });
  });
});
