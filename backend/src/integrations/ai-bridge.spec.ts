import { AiBridgeService } from "./ai-bridge.service";
import * as crypto from "node:crypto";

const URL = "http://localhost:4200";
const SECRET = "test-secret-not-a-real-key";

function withConfig<T>(fn: () => T): T {
  const prevUrl = process.env.KEWY_AI_URL;
  const prevSecret = process.env.KEWY_AI_WEBHOOK_SECRET;
  process.env.KEWY_AI_URL = URL;
  process.env.KEWY_AI_WEBHOOK_SECRET = SECRET;
  try {
    return fn();
  } finally {
    if (prevUrl === undefined) delete process.env.KEWY_AI_URL;
    else process.env.KEWY_AI_URL = prevUrl;
    if (prevSecret === undefined) delete process.env.KEWY_AI_WEBHOOK_SECRET;
    else process.env.KEWY_AI_WEBHOOK_SECRET = prevSecret;
  }
}

const PAYLOAD = {
  workspaceId: "ws1",
  conversationId: "c1",
  contactId: "ct1",
  channel: "whatsapp",
  messageId: "wamid.X",
  body: "مرحبا بدي صبغة",
  contactName: "سارة",
  contactPhone: "+962790000001",
  windowOpen: true,
  receivedAt: "2026-08-28T09:00:00.000Z",
};

describe("AiBridgeService", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  describe("isConfigured", () => {
    it("is false when the env vars are absent — a workspace without the module", () => {
      const prevUrl = process.env.KEWY_AI_URL;
      const prevSecret = process.env.KEWY_AI_WEBHOOK_SECRET;
      delete process.env.KEWY_AI_URL;
      delete process.env.KEWY_AI_WEBHOOK_SECRET;
      try {
        expect(new AiBridgeService().isConfigured()).toBe(false);
      } finally {
        if (prevUrl !== undefined) process.env.KEWY_AI_URL = prevUrl;
        if (prevSecret !== undefined) process.env.KEWY_AI_WEBHOOK_SECRET = prevSecret;
      }
    });

    it("is false when only one of the two is set (half-configured is not configured)", () => {
      const prev = process.env.KEWY_AI_WEBHOOK_SECRET;
      process.env.KEWY_AI_URL = URL;
      delete process.env.KEWY_AI_WEBHOOK_SECRET;
      try {
        expect(new AiBridgeService().isConfigured()).toBe(false);
      } finally {
        delete process.env.KEWY_AI_URL;
        if (prev !== undefined) process.env.KEWY_AI_WEBHOOK_SECRET = prev;
      }
    });

    it("is true when both are set", () => {
      expect(withConfig(() => new AiBridgeService().isConfigured())).toBe(true);
    });
  });

  describe("notifyInbound", () => {
    it("signs the exact bytes it sends", async () => {
      let sentBody = "";
      let sentSig = "";
      global.fetch = jest.fn(async (_url: any, init: any) => {
        sentBody = init.body;
        sentSig = init.headers["x-kewy-signature"];
        return { ok: true, status: 200, statusText: "OK" } as any;
      }) as any;

      await withConfig(() => new AiBridgeService().notifyInbound(PAYLOAD));

      const expected = crypto.createHmac("sha256", SECRET).update(sentBody).digest("hex");
      expect(sentSig).toBe(expected);
      // The event name must be inside the signed payload, not just a header.
      expect(JSON.parse(sentBody).event).toBe("message.received");
    });

    it("preserves Arabic in the body", async () => {
      let sentBody = "";
      global.fetch = jest.fn(async (_u: any, init: any) => {
        sentBody = init.body;
        return { ok: true, status: 200, statusText: "OK" } as any;
      }) as any;
      await withConfig(() => new AiBridgeService().notifyInbound(PAYLOAD));
      expect(JSON.parse(sentBody).body).toBe("مرحبا بدي صبغة");
    });

    it("forwards windowOpen so the agent knows if it may free-text", async () => {
      let sentBody = "";
      global.fetch = jest.fn(async (_u: any, init: any) => {
        sentBody = init.body;
        return { ok: true, status: 200, statusText: "OK" } as any;
      }) as any;
      await withConfig(() =>
        new AiBridgeService().notifyInbound({ ...PAYLOAD, windowOpen: false }),
      );
      expect(JSON.parse(sentBody).windowOpen).toBe(false);
    });

    it("does nothing when unconfigured", async () => {
      const spy = jest.fn();
      global.fetch = spy as any;
      const prevUrl = process.env.KEWY_AI_URL;
      delete process.env.KEWY_AI_URL;
      try {
        await new AiBridgeService().notifyInbound(PAYLOAD);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        if (prevUrl !== undefined) process.env.KEWY_AI_URL = prevUrl;
      }
    });

    // The whole point of the design: ingestInbound must survive an AI outage,
    // because Meta redelivers on any non-200 and we'd duplicate the message.
    it("NEVER throws when the AI service is unreachable", async () => {
      global.fetch = jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as any;
      await expect(
        withConfig(() => new AiBridgeService().notifyInbound(PAYLOAD)),
      ).resolves.toBeUndefined();
    });

    it("NEVER throws when the AI service returns 500", async () => {
      global.fetch = jest.fn(
        async () => ({ ok: false, status: 500, statusText: "Server Error" }) as any,
      ) as any;
      await expect(
        withConfig(() => new AiBridgeService().notifyInbound(PAYLOAD)),
      ).resolves.toBeUndefined();
    });

    it("NEVER throws when the request times out", async () => {
      global.fetch = jest.fn(async (_u: any, init: any) => {
        // Simulate the AbortController firing.
        const err: any = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      }) as any;
      await expect(
        withConfig(() => new AiBridgeService().notifyInbound(PAYLOAD)),
      ).resolves.toBeUndefined();
    });

    it("posts to /ai/inbound on the configured base url, tolerating a trailing slash", async () => {
      const urls: string[] = [];
      global.fetch = jest.fn(async (url: any) => {
        urls.push(String(url));
        return { ok: true, status: 200, statusText: "OK" } as any;
      }) as any;

      process.env.KEWY_AI_URL = "http://localhost:4200/";
      process.env.KEWY_AI_WEBHOOK_SECRET = SECRET;
      try {
        await new AiBridgeService().notifyInbound(PAYLOAD);
      } finally {
        delete process.env.KEWY_AI_URL;
        delete process.env.KEWY_AI_WEBHOOK_SECRET;
      }
      expect(urls[0]).toBe("http://localhost:4200/ai/inbound");
    });
  });

  describe("verifyInboundSignature", () => {
    const raw = JSON.stringify({ conversationId: "c1", body: "أهلا فيكي" });

    it("accepts a correct signature", () => {
      const sig = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
      expect(
        withConfig(() => new AiBridgeService().verifyInboundSignature(raw, sig)),
      ).toBe(true);
    });

    it("rejects a signature over different bytes", () => {
      const sig = crypto.createHmac("sha256", SECRET).update(raw + " ").digest("hex");
      expect(
        withConfig(() => new AiBridgeService().verifyInboundSignature(raw, sig)),
      ).toBe(false);
    });

    it("rejects a signature made with the wrong secret", () => {
      const sig = crypto.createHmac("sha256", "wrong-secret").update(raw).digest("hex");
      expect(
        withConfig(() => new AiBridgeService().verifyInboundSignature(raw, sig)),
      ).toBe(false);
    });

    it("rejects a missing signature", () => {
      expect(
        withConfig(() => new AiBridgeService().verifyInboundSignature(raw, undefined)),
      ).toBe(false);
    });

    // timingSafeEqual throws on a length mismatch, which would leak length
    // information as a 500 instead of a clean rejection.
    it("rejects a short signature without throwing", () => {
      expect(
        withConfig(() => new AiBridgeService().verifyInboundSignature(raw, "abc")),
      ).toBe(false);
    });

    it("rejects everything when unconfigured, even a well-formed signature", () => {
      const sig = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
      const prevUrl = process.env.KEWY_AI_URL;
      delete process.env.KEWY_AI_URL;
      try {
        expect(new AiBridgeService().verifyInboundSignature(raw, sig)).toBe(false);
      } finally {
        if (prevUrl !== undefined) process.env.KEWY_AI_URL = prevUrl;
      }
    });
  });
});
