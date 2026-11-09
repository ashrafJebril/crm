import { HttpException, Logger } from "@nestjs/common";
import { ZernioBudget, zernioHealthRpm } from "../../campaigns/sending/zernio-budget";
import { ZernioRateLimitError } from "../../integrations/zernio.client";
import { HEALTH_RETRIES, zernioHealthCall } from "./health-budget";
import { mergeHealth, SIGNAL_NAMES } from "./health-model";
import { readZernioHealth } from "./zernio-health.reader";

const NOW = new Date("2026-11-09T10:00:00.000Z");

/** A virtual clock: sleeping advances time instantly. */
function clock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

function budgetWithSpies(env: Record<string, string> = {}) {
  const c = clock();
  const budget = new ZernioBudget(env, c);
  const campaign = jest.spyOn(budget.campaign, "take");
  const health = jest.spyOn(budget.health, "take");
  const pause = jest.spyOn(budget.campaign, "pause");
  return { c, budget, campaign, health, pause };
}

const INFO = { phone: { quality_rating: "GREEN", messaging_limit_tier: "TIER_1K", name_status: "APPROVED", status: "CONNECTED" } };

describe("every zernio health call takes the shared budget", () => {
  beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it("ZERNIO_HEALTH_RPM defaults to 30 and the budget has a health bucket", () => {
    expect(zernioHealthRpm({})).toBe(30);
    expect(zernioHealthRpm({ ZERNIO_HEALTH_RPM: "12" })).toBe(12);
    expect(zernioHealthRpm({ ZERNIO_HEALTH_RPM: "0" })).toBe(30);
    expect(new ZernioBudget({}).health.rpm).toBe(30);
    expect(ZernioBudget.shared().health).toBeDefined();
  });

  it("a check is 2 calls; tokens taken equal calls made, campaign before health", async () => {
    const { budget, campaign, health } = budgetWithSpies();
    const order: string[] = [];
    campaign.mockImplementation(async () => void order.push("campaign"));
    health.mockImplementation(async () => void order.push("health"));
    const zernio = {
      whatsappNumberInfo: jest.fn(async () => {
        order.push("number-info");
        return INFO;
      }),
      whatsappTemplates: jest.fn(async () => {
        order.push("templates");
        return [];
      }),
    };
    await readZernioHealth(zernio, budget, "acc1");
    expect(zernio.whatsappNumberInfo).toHaveBeenCalledWith("acc1");
    expect(zernio.whatsappTemplates).toHaveBeenCalledWith("acc1");
    expect(order).toEqual(["campaign", "health", "number-info", "campaign", "health", "templates"]);
    expect(campaign).toHaveBeenCalledTimes(2);
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("the health bucket caps health calls with a fake clock (30/min)", async () => {
    const { c, budget, campaign, health } = budgetWithSpies();
    let calls = 0;
    for (let i = 0; i < 31; i++) await zernioHealthCall(async () => void calls++, budget);
    expect(calls).toBe(31);
    expect(campaign).toHaveBeenCalledTimes(31);
    expect(health).toHaveBeenCalledTimes(31);
    // 30 per minute: the 31st call starts a full minute after the first.
    expect(c.now()).toBeGreaterThanOrEqual(60_000);
  });

  it("a 429 with Retry-After pauses the shared campaign bucket and is retried", async () => {
    const { c, budget, campaign, health, pause } = budgetWithSpies();
    let n = 0;
    const out = await zernioHealthCall(async () => {
      n++;
      if (n === 1) throw new ZernioRateLimitError("slow", 7_000);
      return "ok";
    }, budget);
    expect(out).toBe("ok");
    expect(n).toBe(2);
    expect(pause).toHaveBeenCalledWith(7_000);
    expect(c.sleeps).toContain(7_000);
    expect(campaign).toHaveBeenCalledTimes(2);
    expect(health).toHaveBeenCalledTimes(2);
  });

  it("a persistent 429 gives up after the retries and the field is check_failed", async () => {
    const { budget, campaign } = budgetWithSpies();
    const zernio = {
      whatsappNumberInfo: jest.fn(async () => {
        throw new ZernioRateLimitError("slow", 1_000);
      }),
      whatsappTemplates: jest.fn(async () => []),
    };
    const read = await readZernioHealth(zernio, budget, "acc1");
    expect(zernio.whatsappNumberInfo).toHaveBeenCalledTimes(HEALTH_RETRIES + 1);
    expect(campaign).toHaveBeenCalledTimes(HEALTH_RETRIES + 1 + 1); // + the templates call
    const h = mergeHealth(null, read, { now: NOW, trigger: "manual" });
    expect(h.quality.error).toBe("check_failed");
    expect(h.templates.error).toBeNull();
  });
});

describe("zernio reader failures", () => {
  beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());
  const budget = () => new ZernioBudget({ ZERNIO_CAMPAIGN_RPM: "100000", ZERNIO_HEALTH_RPM: "100000" }, clock());

  it.each([
    ["a 404", new HttpException("Account not found", 404)],
    ["the client's reconnect message", new HttpException("Your WhatsApp connection was removed by Meta. Reconnect WhatsApp in Settings → Integrations, then try again.", 400)],
  ])("%s makes every field check_failed, with no templates call", async (_n, err) => {
    const zernio = {
      whatsappNumberInfo: jest.fn(async () => {
        throw err;
      }),
      whatsappTemplates: jest.fn(async () => []),
    };
    const h = mergeHealth(null, await readZernioHealth(zernio, budget(), "acc1"), { now: NOW, trigger: "manual" });
    for (const f of SIGNAL_NAMES) expect({ f, e: h[f].error }).toEqual({ f, e: "check_failed" });
    expect(h.templates.error).toBe("check_failed");
    expect(zernio.whatsappTemplates).not.toHaveBeenCalled();
  });

  it("a 5xx on number-info still reads the templates; a templates failure leaves the fields", async () => {
    const zernio = {
      whatsappNumberInfo: jest.fn(async () => {
        throw new HttpException("bad gateway", 502);
      }),
      whatsappTemplates: jest.fn(async () => [{ id: "1", name: "a", language: "en", status: "APPROVED", category: "UTILITY" }]),
    };
    const h = mergeHealth(null, await readZernioHealth(zernio, budget(), "acc1"), { now: NOW, trigger: "manual" });
    expect(h.quality.error).toBe("check_failed");
    expect(h.templates.value).toMatchObject({ total: 1, approved: 1 });

    const z2 = {
      whatsappNumberInfo: jest.fn(async () => INFO),
      whatsappTemplates: jest.fn(async () => {
        throw new HttpException("bad gateway", 502);
      }),
    };
    const h2 = mergeHealth(null, await readZernioHealth(z2, budget(), "acc1"), { now: NOW, trigger: "manual" });
    expect(h2.quality.value).toBe("GREEN");
    expect(h2.templates).toEqual({ value: "unknown", checkedAt: NOW.toISOString(), error: "check_failed" });
  });

  it("a response without a phone object reads nothing (check_failed), never defaults", async () => {
    const zernio = { whatsappNumberInfo: jest.fn(async () => ({})), whatsappTemplates: jest.fn(async () => []) };
    const h = mergeHealth(null, await readZernioHealth(zernio, budget(), "acc1"), { now: NOW, trigger: "manual" });
    for (const f of ["quality", "tier", "nameStatus", "messaging", "phoneStatus"] as const) expect(h[f].error).toBe("check_failed");
    for (const f of ["verified", "codeVerification", "accountReview"] as const) expect(h[f].error).toBe("unsupported");
  });

  it("no account id → missing_credentials with zero calls", async () => {
    const zernio = { whatsappNumberInfo: jest.fn(), whatsappTemplates: jest.fn() };
    const read = await readZernioHealth(zernio, budget(), null);
    expect(zernio.whatsappNumberInfo).not.toHaveBeenCalled();
    expect(zernio.whatsappTemplates).not.toHaveBeenCalled();
    const h = mergeHealth(null, read, { now: NOW, trigger: "manual" });
    for (const f of SIGNAL_NAMES) expect(h[f].error).toBe("missing_credentials");
  });
});
