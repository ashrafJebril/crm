import { HttpException } from "@nestjs/common";
import { KnowledgeClient } from "./knowledge.client";
import { KnowledgeService } from "./knowledge.service";

const URL_BASE = "http://localhost:4200";
const SECRET = "test-admin-secret-not-a-real-key";

/** Sets the env for the duration of `fn`, including when `fn` is async — a
 *  synchronous restore would clear the config before an awaited call read it. */
function withConfig<T>(fn: () => T): T {
  const prevUrl = process.env.KEWY_AI_URL;
  const prevSecret = process.env.KEWY_AI_ADMIN_SECRET;
  process.env.KEWY_AI_URL = URL_BASE;
  process.env.KEWY_AI_ADMIN_SECRET = SECRET;
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
  if (out instanceof Promise) {
    return out.finally(restore) as unknown as T;
  }
  restore();
  return out;
}

/** Records every outbound call so assertions can inspect the exact wire shape.
 *  No network: `fetch` is the injected seam, exactly as ai-bridge.spec.ts does. */
function stubFetch(
  response: { ok?: boolean; status?: number; body?: unknown } = {},
): { calls: Array<{ url: string; init: any }> } {
  const calls: Array<{ url: string; init: any }> = [];
  global.fetch = jest.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    return {
      ok: response.ok ?? (status >= 200 && status < 300),
      status,
      text: async () => (response.body === undefined ? "" : JSON.stringify(response.body)),
    } as any;
  }) as any;
  return { calls };
}

const WS_A = "cmpayevw8000011v0tgyu6rz1";
const WS_B = "ws-some-other-salon-000000";

describe("KnowledgeService — tenant isolation", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  const svc = () => new KnowledgeService(new KnowledgeClient());

  it("lists using the CALLER's workspace as tenantId", async () => {
    const { calls } = stubFetch({ body: { docs: [] } });
    await withConfig(() => svc().listDocs(WS_A));
    expect(new URL(calls[0].url).searchParams.get("tenantId")).toBe(WS_A);
  });

  // The core guarantee: a user of workspace A must never reach workspace B's
  // knowledge. The only tenant input is the argument the controller fills from
  // @CurrentWorkspace(), so two different workspaces produce two different
  // upstream tenants with no way for a request body to influence either.
  it("a user of workspace A can never read or write workspace B's knowledge", async () => {
    const { calls } = stubFetch({ body: { docs: [] } });
    await withConfig(async () => {
      await svc().listDocs(WS_A);
      await svc().listDocs(WS_B);
      await svc().saveDoc(WS_A, { title: "t", body: "b", kind: "POLICY" });
      await svc().deleteDoc(WS_A, "doc-1");
      await svc().sync(WS_A);
    });

    const tenantOf = (c: { url: string; init: any }) =>
      new URL(c.url).searchParams.get("tenantId") ??
      (c.init.body ? JSON.parse(c.init.body).tenantId : null);

    expect(calls.map(tenantOf)).toEqual([WS_A, WS_B, WS_A, WS_A, WS_A]);
    // Nothing a workspace-A caller did may mention workspace B anywhere.
    const fromA = [calls[0], ...calls.slice(2)];
    for (const c of fromA) {
      expect(c.url).not.toContain(WS_B);
      expect(String(c.init.body ?? "")).not.toContain(WS_B);
    }
  });

  // Defence in depth behind the DTO: even if a tenantId got past validation
  // into the service input object, the service builds the upstream payload
  // field by field and never spreads the caller's object.
  it("ignores a tenantId smuggled into the save input", async () => {
    const { calls } = stubFetch({ body: {} });
    await withConfig(() =>
      svc().saveDoc(WS_A, {
        title: "Cancellation policy",
        body: "24 hours notice.",
        kind: "POLICY",
        // @ts-expect-error — proving the extra key cannot reach the wire.
        tenantId: WS_B,
      }),
    );
    const sent = JSON.parse(calls[0].init.body);
    expect(sent.tenantId).toBe(WS_A);
    expect(calls[0].init.body).not.toContain(WS_B);
  });

  it("puts owner-authored docs above synced ones", async () => {
    stubFetch({
      body: {
        docs: [
          { id: "s1", editable: false, updatedAt: "2026-08-30T00:00:00.000Z" },
          { id: "o1", editable: true, updatedAt: "2026-08-01T00:00:00.000Z" },
          { id: "o2", editable: true, updatedAt: "2026-08-20T00:00:00.000Z" },
        ],
      },
    });
    const { docs } = await withConfig(() => svc().listDocs(WS_A));
    expect(docs.map((d) => d.id)).toEqual(["o2", "o1", "s1"]);
  });
});

describe("KnowledgeClient — the secret and the wire", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it("sends the admin secret as a header and never in the URL", async () => {
    const { calls } = stubFetch({ body: { docs: [] } });
    await withConfig(() => new KnowledgeClient().listDocs(WS_A));
    expect(calls[0].init.headers["x-kewy-admin-secret"]).toBe(SECRET);
    expect(calls[0].url).not.toContain(SECRET);
  });

  it("targets the /api/v1 knowledge routes, tolerating a trailing slash", async () => {
    const { calls } = stubFetch({ body: { docs: [] } });
    const prev = process.env.KEWY_AI_URL;
    process.env.KEWY_AI_URL = "http://localhost:4200/";
    process.env.KEWY_AI_ADMIN_SECRET = SECRET;
    try {
      await new KnowledgeClient().listDocs(WS_A);
    } finally {
      if (prev === undefined) delete process.env.KEWY_AI_URL;
      else process.env.KEWY_AI_URL = prev;
      delete process.env.KEWY_AI_ADMIN_SECRET;
    }
    expect(calls[0].url).toBe(
      `http://localhost:4200/api/v1/knowledge/docs?tenantId=${WS_A}`,
    );
  });

  it("uses the webhook secret NOWHERE — it would 403 upstream", async () => {
    const { calls } = stubFetch({ body: { docs: [] } });
    const prevWebhook = process.env.KEWY_AI_WEBHOOK_SECRET;
    process.env.KEWY_AI_WEBHOOK_SECRET = "the-wrong-secret-entirely";
    try {
      await withConfig(() => new KnowledgeClient().listDocs(WS_A));
    } finally {
      if (prevWebhook === undefined) delete process.env.KEWY_AI_WEBHOOK_SECRET;
      else process.env.KEWY_AI_WEBHOOK_SECRET = prevWebhook;
    }
    expect(JSON.stringify(calls[0].init)).not.toContain("the-wrong-secret-entirely");
  });

  it("id absent = create, id present = update", async () => {
    const { calls } = stubFetch({ body: {} });
    await withConfig(async () => {
      const c = new KnowledgeClient();
      await c.upsertDoc({ tenantId: WS_A, title: "t", body: "b", kind: "FAQ" });
      await c.upsertDoc({ tenantId: WS_A, id: "d1", title: "t", body: "b", kind: "FAQ" });
    });
    expect(JSON.parse(calls[0].init.body).id).toBeUndefined();
    expect(JSON.parse(calls[1].init.body).id).toBe("d1");
  });

  it("preserves Arabic in the body it sends", async () => {
    const { calls } = stubFetch({ body: {} });
    await withConfig(() =>
      new KnowledgeClient().upsertDoc({
        tenantId: WS_A,
        title: "سياسة الإلغاء",
        body: "الإلغاء قبل ٢٤ ساعة مجاني.",
        kind: "POLICY",
      }),
    );
    expect(JSON.parse(calls[0].init.body).title).toBe("سياسة الإلغاء");
  });
});

describe("KnowledgeClient — failure is structured, never a 500 stack", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  const expectHttp = async (p: Promise<unknown>, status: number, code: string) => {
    await expect(p).rejects.toBeInstanceOf(HttpException);
    try {
      await p;
    } catch (e) {
      const err = e as HttpException;
      expect(err.getStatus()).toBe(status);
      expect((err.getResponse() as { code: string }).code).toBe(code);
    }
  };

  // The CRM must stay up when the AI service is down. 503, not 500.
  it("maps a connection refusal to a 503 the UI can render", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    await withConfig(() =>
      expectHttp(new KnowledgeClient().listDocs(WS_A), 503, "AI_UNAVAILABLE"),
    );
  });

  it("maps a timeout to its own code so the UI can warn the save may have landed", async () => {
    global.fetch = jest.fn(async () => {
      const err: any = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }) as any;
    await withConfig(() =>
      expectHttp(new KnowledgeClient().listDocs(WS_A), 503, "AI_TIMEOUT"),
    );
  });

  it("answers 503 when the module is not configured at all", async () => {
    const spy = jest.fn();
    global.fetch = spy as any;
    const prevUrl = process.env.KEWY_AI_URL;
    const prevSecret = process.env.KEWY_AI_ADMIN_SECRET;
    delete process.env.KEWY_AI_URL;
    delete process.env.KEWY_AI_ADMIN_SECRET;
    try {
      await expectHttp(new KnowledgeClient().listDocs(WS_A), 503, "AI_NOT_CONFIGURED");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (prevUrl !== undefined) process.env.KEWY_AI_URL = prevUrl;
      if (prevSecret !== undefined) process.env.KEWY_AI_ADMIN_SECRET = prevSecret;
    }
  });

  it("passes a 400 validation complaint through — the owner can act on it", async () => {
    stubFetch({ status: 400, body: { message: "title: String must contain at most 200 character(s)" } });
    await withConfig(async () => {
      try {
        await new KnowledgeClient().upsertDoc({
          tenantId: WS_A,
          title: "x".repeat(300),
          body: "b",
          kind: "OTHER",
        });
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as HttpException).getStatus()).toBe(400);
        expect((e as HttpException).getResponse()).toMatchObject({
          code: "AI_REJECTED",
          message: expect.stringContaining("200 character"),
        });
      }
    });
  });

  it("SWALLOWS a 5xx body — upstream stacks must not reach the browser", async () => {
    stubFetch({
      status: 500,
      body: { message: "Error: connect ECONNREFUSED 10.0.0.5:5432 at Pool._acquire (/srv/db.js:41)" },
    });
    await withConfig(async () => {
      try {
        await new KnowledgeClient().listDocs(WS_A);
        throw new Error("should have thrown");
      } catch (e) {
        const body = (e as HttpException).getResponse() as { code: string; message: string };
        expect(body.code).toBe("AI_ERROR");
        expect(body.message).not.toContain("ECONNREFUSED");
        expect(body.message).not.toContain("5432");
      }
    });
  });

  it("never leaks the secret in an auth-failure body", async () => {
    stubFetch({ status: 403, body: { message: `Invalid admin secret ${SECRET}` } });
    await withConfig(async () => {
      try {
        await new KnowledgeClient().listDocs(WS_A);
        throw new Error("should have thrown");
      } catch (e) {
        const body = (e as HttpException).getResponse() as { code: string; message: string };
        expect(body.code).toBe("AI_AUTH_FAILED");
        expect(JSON.stringify(body)).not.toContain(SECRET);
      }
    });
  });

  it("keeps upstream's 404 as a 404 — a delete that matched nothing", async () => {
    stubFetch({ status: 404, body: { message: "No knowledge doc d9 for tenant." } });
    await withConfig(() =>
      expectHttp(new KnowledgeClient().deleteDoc(WS_A, "d9"), 404, "NOT_FOUND"),
    );
  });
});
