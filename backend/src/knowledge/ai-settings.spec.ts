import { HttpException } from "@nestjs/common";
import { KnowledgeClient } from "./knowledge.client";
import { AiSettingsService } from "./ai-settings.service";
import { makeFakePrisma } from "../channels/test-prisma";
import { AgentReplyGate, invalidateAgentGate } from "../agent/agent-reply-gate";

const URL_BASE = "http://localhost:4200";
const SECRET = "test-admin-secret-not-a-real-key";

/** Same helper as knowledge.spec.ts: env set for the duration of `fn`,
 *  including when `fn` is async. */
/** Runs `fn` with kewy-ai configured (the default), or with both variables
 *  emptied so a developer's local `.env` cannot make "unconfigured" tests call out. */
function withConfig<T>(fn: () => T, configured = true): T {
  const prevUrl = process.env.KEWY_AI_URL;
  const prevSecret = process.env.KEWY_AI_ADMIN_SECRET;
  process.env.KEWY_AI_URL = configured ? URL_BASE : "";
  process.env.KEWY_AI_ADMIN_SECRET = configured ? SECRET : "";
  const restore = () => {
    if (prevUrl === undefined) delete process.env.KEWY_AI_URL;
    else process.env.KEWY_AI_URL = prevUrl;
    if (prevSecret === undefined) delete process.env.KEWY_AI_ADMIN_SECRET;
    else process.env.KEWY_AI_ADMIN_SECRET = prevSecret;
  };
  let out: T;
  try {
    out = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (out instanceof Promise) return out.finally(restore) as unknown as T;
  restore();
  return out;
}

/** No network — `fetch` is the injected seam. `bodies` lets one test drive a
 *  sequence of responses (a PATCH followed by the service's re-read). */
function stubFetch(
  response: { status?: number; body?: unknown; bodies?: unknown[] } = {},
): { calls: Array<{ url: string; init: any }> } {
  const calls: Array<{ url: string; init: any }> = [];
  let n = 0;
  global.fetch = jest.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    const body = response.bodies ? response.bodies[Math.min(n++, response.bodies.length - 1)] : response.body;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    } as any;
  }) as any;
  return { calls };
}

const WS_A = "cmpayevw8000011v0tgyu6rz1";
const WS_B = "ws-some-other-salon-000000";

const CONFIG = {
  tenantId: WS_A,
  aiEnabled: true,
  killSwitch: false,
  autonomyMode: "AUTONOMOUS",
  personaName: "سلمى",
  locale: "ar",
  dailyCostCapJod: null,
};

describe("AiSettingsService — tenant isolation", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  const svc = () => new AiSettingsService(new KnowledgeClient());

  // The core guarantee, and it bites harder here than on the knowledge routes:
  // this surface can SILENCE a salon's bot. The only tenant input is the
  // argument the controller fills from @CurrentWorkspace().
  it("a user of workspace A can never read or toggle workspace B's assistant", async () => {
    const { calls } = stubFetch({ bodies: [CONFIG, { aiEnabled: false, changed: true }, CONFIG, CONFIG] });
    await withConfig(async () => {
      await svc().get(WS_A);
      await svc().setEnabled(WS_A, { enabled: false, reason: "closed for Eid" });
      await svc().setAutonomyMode(WS_A, "SHADOW");
    });

    // Every call must carry workspace A's tenant in its path and nowhere name B.
    for (const c of calls) {
      expect(c.url).toContain(encodeURIComponent(WS_A));
      expect(c.url).not.toContain(WS_B);
      expect(String(c.init.body ?? "")).not.toContain(WS_B);
    }
  });

  it("routes each workspace to its OWN tenant, never a shared one", async () => {
    const { calls } = stubFetch({ body: CONFIG });
    await withConfig(async () => {
      await svc().get(WS_A);
      await svc().get(WS_B);
    });
    expect(calls[0].url).toContain(WS_A);
    expect(calls[1].url).toContain(WS_B);
    expect(calls[1].url).not.toContain(WS_A);
  });

  it("sends the admin secret as a header and never to the browser's side of the wire", async () => {
    const { calls } = stubFetch({ body: CONFIG });
    const view = await withConfig(() => svc().get(WS_A));
    expect(calls[0].init.headers["x-kewy-admin-secret"]).toBe(SECRET);
    expect(calls[0].url).not.toContain(SECRET);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });
});

describe("AiSettingsService — the three states are not conflated", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });
  const svc = () => new AiSettingsService(new KnowledgeClient());

  it("reports the effective state: an operator kill switch beats aiEnabled", async () => {
    stubFetch({ body: { ...CONFIG, aiEnabled: true, killSwitch: true } });
    const view = await withConfig(() => svc().get(WS_A));
    // Showing "on" while a kill switch holds the agent off would be a lie the
    // owner acts on — they'd wait for replies that never come.
    expect(view.aiEnabled).toBe(false);
  });

  it("keeps autonomyMode independent of the on/off state", async () => {
    stubFetch({ body: { ...CONFIG, aiEnabled: true, killSwitch: false, autonomyMode: "SHADOW" } });
    const view = await withConfig(() => svc().get(WS_A));
    // SHADOW is ON — the model runs and costs money, it just doesn't send.
    expect(view).toMatchObject({ aiEnabled: true, autonomyMode: "SHADOW" });
  });

  it("exposes only the whitelisted fields — nothing secret-shaped", async () => {
    stubFetch({ body: { ...CONFIG, apiKeyRef: "vault://should-never-appear", escalationTarget: null } });
    const view = await withConfig(() => svc().get(WS_A));
    expect(Object.keys(view).sort()).toEqual(
      // SP-20 adds stoppedLocally (a boolean, nothing secret-shaped).
      ["aiEnabled", "autonomyMode", "configured", "dailyCostCapJod", "locale", "personaName", "stoppedLocally"].sort(),
    );
    expect(JSON.stringify(view)).not.toContain("vault://");
  });

  it("answers configured:false without calling upstream when there is no AI module", async () => {
    const spy = jest.fn();
    global.fetch = spy as any;
    const prevUrl = process.env.KEWY_AI_URL;
    const prevSecret = process.env.KEWY_AI_ADMIN_SECRET;
    delete process.env.KEWY_AI_URL;
    delete process.env.KEWY_AI_ADMIN_SECRET;
    try {
      const view = await new AiSettingsService(new KnowledgeClient()).get(WS_A);
      expect(view.configured).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (prevUrl !== undefined) process.env.KEWY_AI_URL = prevUrl;
      if (prevSecret !== undefined) process.env.KEWY_AI_ADMIN_SECRET = prevSecret;
    }
  });
});

describe("AiSettingsService — the reason rule", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });
  const svc = () => new AiSettingsService(new KnowledgeClient());

  it("refuses to disable without a reason, BEFORE touching the network", async () => {
    const { calls } = stubFetch({ body: {} });
    await withConfig(async () => {
      try {
        await svc().setEnabled(WS_A, { enabled: false });
        throw new Error("should have thrown");
      } catch (e) {
        const err = e as HttpException;
        expect(err.getStatus()).toBe(400);
        expect((err.getResponse() as { code: string }).code).toBe("REASON_REQUIRED");
      }
    });
    // Our own 400, not a passed-through upstream one — the owner reads our
    // wording, and the bot is never even asked to stop.
    expect(calls).toHaveLength(0);
  });

  it("treats a whitespace-only reason as no reason", async () => {
    const { calls } = stubFetch({ body: {} });
    await withConfig(async () => {
      await expect(svc().setEnabled(WS_A, { enabled: false, reason: "   " })).rejects.toBeInstanceOf(
        HttpException,
      );
    });
    expect(calls).toHaveLength(0);
  });

  it("sends the trimmed reason upstream when disabling", async () => {
    const { calls } = stubFetch({ body: { aiEnabled: false, changed: true } });
    await withConfig(() =>
      svc().setEnabled(WS_A, { enabled: false, reason: "  الصالون مسكّر لعيد  " }),
    );
    const sent = JSON.parse(calls[0].init.body);
    expect(sent).toEqual({ aiEnabled: false, reason: "الصالون مسكّر لعيد" });
    expect(calls[0].url).toContain("/kill-switch");
  });

  it("needs no reason to turn it back ON, and omits the field entirely", async () => {
    const { calls } = stubFetch({ body: { aiEnabled: true, changed: true } });
    await withConfig(() => svc().setEnabled(WS_A, { enabled: true }));
    const sent = JSON.parse(calls[0].init.body);
    expect(sent).toEqual({ aiEnabled: true });
    // Not `reason: ""` — upstream's 1..500 rule would reject that.
    expect("reason" in sent).toBe(false);
  });
});

describe("AiSettingsService — delivery mode", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });
  const svc = () => new AiSettingsService(new KnowledgeClient());

  it("PATCHes only autonomyMode, never a whole config object", async () => {
    const { calls } = stubFetch({ bodies: [{ ...CONFIG, autonomyMode: "SHADOW" }, { ...CONFIG, autonomyMode: "SHADOW" }] });
    const view = await withConfig(() => svc().setAutonomyMode(WS_A, "SHADOW"));
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init.body)).toEqual({ autonomyMode: "SHADOW" });
    // Re-reads so the screen reflects stored state, not the write's echo.
    expect(calls[1].init.method).toBe("GET");
    expect(view.autonomyMode).toBe("SHADOW");
  });

  it("switching delivery mode never touches the on/off switch", async () => {
    const { calls } = stubFetch({ bodies: [CONFIG, CONFIG] });
    await withConfig(() => svc().setAutonomyMode(WS_A, "AUTONOMOUS"));
    for (const c of calls) {
      expect(c.url).not.toContain("kill-switch");
      expect(String(c.init.body ?? "")).not.toContain("aiEnabled");
    }
  });
});

describe("AiSettingsService — failure keeps the CRM up", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });
  const svc = () => new AiSettingsService(new KnowledgeClient());

  const expectHttp = async (p: Promise<unknown>, status: number, code: string) => {
    try {
      await p;
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as HttpException;
      expect(err.getStatus()).toBe(status);
      expect((err.getResponse() as { code: string }).code).toBe(code);
    }
  };

  it("maps an unreachable kewy-ai to 503 AI_UNAVAILABLE, not a 500", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    await withConfig(() => expectHttp(svc().get(WS_A), 503, "AI_UNAVAILABLE"));
  });

  it("maps a timeout to AI_TIMEOUT", async () => {
    global.fetch = jest.fn(async () => {
      const err: any = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }) as any;
    await withConfig(() => expectHttp(svc().get(WS_A), 503, "AI_TIMEOUT"));
  });

  it("SWALLOWS an upstream 5xx body — stacks must not reach the browser", async () => {
    stubFetch({
      status: 500,
      body: { message: "Error: connect ECONNREFUSED 10.0.0.5:5432 at Pool._acquire (/srv/db.js:41)" },
    });
    await withConfig(async () => {
      try {
        await svc().setEnabled(WS_A, { enabled: false, reason: "testing" });
        throw new Error("should have thrown");
      } catch (e) {
        const body = (e as HttpException).getResponse() as { code: string; message: string };
        expect(body.code).toBe("AI_ERROR");
        expect(body.message).not.toContain("5432");
      }
    });
  });

  it("passes an upstream 4xx complaint through as a 400 the UI can render", async () => {
    stubFetch({ status: 400, body: { message: "Empty patch — send at least one field to change." } });
    await withConfig(() => expectHttp(svc().setAutonomyMode(WS_A, "SHADOW"), 400, "AI_REJECTED"));
  });

  it("never leaks the secret in an auth failure", async () => {
    stubFetch({ status: 403, body: { message: `Invalid admin secret ${SECRET}` } });
    await withConfig(async () => {
      try {
        await svc().get(WS_A);
        throw new Error("should have thrown");
      } catch (e) {
        const body = (e as HttpException).getResponse();
        expect(JSON.stringify(body)).not.toContain(SECRET);
      }
    });
  });
});

// ─── SP-20 (ruling 3): the toggle also writes the CRM-side stop ──────────
describe("AiSettingsService — the local emergency stop (SP-20)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
    invalidateAgentGate();
  });
  const world = () => {
    const prisma = makeFakePrisma({ workspace: [{ id: WS_A, name: "Salon", slug: "s", timezone: "Asia/Riyadh" }] });
    return { prisma, svc: new AiSettingsService(new KnowledgeClient(), prisma as never) };
  };

  it("toggle writes the local stop and clears it on enable", async () => {
    // With kewy-ai configured: the local stop is written AND kewy-ai still gets its call.
    const { prisma, svc } = world();
    const { calls } = stubFetch({ bodies: [{ aiEnabled: false, changed: true }, { aiEnabled: true, changed: true }] });
    await withConfig(() => svc.setEnabled(WS_A, { enabled: false, reason: "Holiday", userId: "u1" }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/kill-switch");
    expect(JSON.parse(calls[0].init.body)).toEqual({ aiEnabled: false, reason: "Holiday" });
    expect(prisma.db.agentSettings[0]).toMatchObject({ stoppedReason: "Holiday", stoppedById: "u1", version: 0 });
    expect(prisma.db.agentSettings[0].stoppedAt).toBeInstanceOf(Date);

    // The reply gate sees the stop at once (no 30 s cache wait in this process).
    const gate = new AgentReplyGate(prisma as never);
    expect(await gate.decide(WS_A, { conversationId: null, contactId: null })).toEqual({ reply: false, reason: "stopped" });

    await withConfig(() => svc.setEnabled(WS_A, { enabled: true, userId: "u1" }));
    expect(calls).toHaveLength(2);
    expect(prisma.db.agentSettings[0]).toMatchObject({ stoppedAt: null, stoppedReason: null, stoppedById: null });
    expect(await gate.decide(WS_A, { conversationId: null, contactId: null })).toEqual({ reply: true, reason: "ok" });
  });

  it("without kewy-ai config only the local stop changes", () =>
    withConfig(async () => {
    const { prisma, svc } = world();
    const { calls } = stubFetch({ body: {} });
    const off = await svc.setEnabled(WS_A, { enabled: false, reason: "Closed today", userId: "u1" });
    expect(calls).toHaveLength(0);
    expect(off).toEqual({ aiEnabled: false, changed: true, reason: "Closed today" });
    expect(prisma.db.agentSettings[0].stoppedAt).toBeInstanceOf(Date);
    const view = await svc.get(WS_A);
    expect(view).toMatchObject({ configured: false, stoppedLocally: true });
    // Turning it off twice is not a change.
    expect(await svc.setEnabled(WS_A, { enabled: false, reason: "Still closed" })).toMatchObject({ changed: false });
    const on = await svc.setEnabled(WS_A, { enabled: true });
    expect(on).toEqual({ aiEnabled: true, changed: true });
    expect((await svc.get(WS_A)).stoppedLocally).toBe(false);
    expect(calls).toHaveLength(0);
    }, false));

  it("enabling while kewy-ai fails clears the local stop and returns the upstream failure", async () => {
    const { prisma, svc } = world();
    stubFetch({ body: { aiEnabled: false, changed: true } });
    await withConfig(() => svc.setEnabled(WS_A, { enabled: false, reason: "Holiday", userId: "u1" }));
    expect(prisma.db.agentSettings[0].stoppedAt).toBeInstanceOf(Date);

    stubFetch({ status: 500, body: { message: "upstream exploded at /srv/x.js:1" } });
    let err: unknown;
    await withConfig(async () => {
      err = await svc.setEnabled(WS_A, { enabled: true, userId: "u1" }).then(
        () => null,
        (e: unknown) => e,
      );
    });
    // The owner sees kewy-ai's failure (our structured, scrubbed error)...
    expect(err).toBeInstanceOf(HttpException);
    expect(((err as HttpException).getResponse() as { code: string }).code).toBe("AI_ERROR");
    // ...and the CRM-side stop is cleared: the l path replies again; kewy-ai keeps its own switch until retried.
    expect(prisma.db.agentSettings[0]).toMatchObject({ stoppedAt: null, stoppedReason: null, stoppedById: null });
    const gate = new AgentReplyGate(prisma as never);
    expect(await gate.decide(WS_A, { conversationId: null, contactId: null })).toEqual({ reply: true, reason: "ok" });
  });

  it("the reason rule still applies before anything is written", async () => {
    const { prisma, svc } = world();
    await expect(svc.setEnabled(WS_A, { enabled: false })).rejects.toBeInstanceOf(HttpException);
    expect(prisma.db.agentSettings ?? []).toHaveLength(0);
  });

  it("GET adds stoppedLocally and shows the agent off while it holds", async () => {
    const { prisma, svc } = world();
    stubFetch({ body: CONFIG });
    expect(await withConfig(() => svc.get(WS_A))).toMatchObject({ aiEnabled: true, stoppedLocally: false });
    prisma.db.agentSettings = [{ id: "as", workspaceId: WS_A, stoppedAt: new Date(), excludedTagIds: [], tone: [], version: 0 }];
    expect(await withConfig(() => svc.get(WS_A))).toMatchObject({ aiEnabled: false, stoppedLocally: true, configured: true });
  });
});
