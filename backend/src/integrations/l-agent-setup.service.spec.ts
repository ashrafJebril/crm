import { LAgentSetupService } from "./l-agent-setup.service";
import { withAdvisoryLocks } from "../channels/test-prisma";

/** The unscoped client the service uses: a workspace lookup plus interactive transactions with real advisory locks. */
function rawClient(lWorkspaceId: string | null = "l-1") {
  const raw: any = {
    workspace: { findUnique: jest.fn().mockResolvedValue({ lWorkspaceId }) },
    // SP-22: no ledger rows (the default skills).
    skillInstall: { findMany: jest.fn().mockResolvedValue([]) },
    $executeRaw: jest.fn(async () => 0),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(raw)),
  };
  const locks = withAdvisoryLocks(raw);
  return { raw, locks };
}

describe("LAgentSetupService", () => {
  let svc: LAgentSetupService;
  let prisma: any;
  let client: any;
  let resolver: any;
  let mcp: any;
  let tokens: any;

  beforeEach(() => {
    prisma = { raw: rawClient().raw };
    client = { request: jest.fn() };
    resolver = { resolveSlug: jest.fn().mockResolvedValue("customer-support") };
    mcp = {
      list: jest.fn().mockResolvedValue({ connected: true, servers: [] }),
      create: jest.fn().mockResolvedValue({ id: "srv-1" }),
      bind: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    tokens = {
      status: jest.fn().mockResolvedValue({ connected: false }),
      generate: jest.fn().mockResolvedValue({ token: "mcp_abc_secret", endpointUrl: "http://crm/api/mcp/v1" }),
    };
    client.request.mockImplementation(async (path: string) => {
      if (path.endsWith("/agents")) return [{ slug: "customer-support", live_version: 1 }];
      if (path.endsWith("/prompts")) return [{ version: 1, content: "You are support." }];
      return undefined;
    });
    svc = new LAgentSetupService(prisma, client, resolver, mcp, tokens);
  });

  it("registers the CRM MCP server with a bearer token, binds it, and extends the prompt", async () => {
    const result = await svc.ensure("ws-1");

    expect(result).toEqual({ mcpServer: "created", prompt: "updated" });
    expect(mcp.create).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        name: "kewy_crm",
        url: "http://crm/api/mcp/v1",
        headers: { Authorization: "Bearer mcp_abc_secret" },
      }),
    );
    expect(mcp.bind).toHaveBeenCalledWith("ws-1", "srv-1");
    const put = client.request.mock.calls.find(([, o]: any[]) => o?.method === "PUT");
    expect(put[0]).toBe("/workspaces/l-1/agents/customer-support/prompt");
    expect(put[1].body.content).toContain("You are support.");
    expect(put[1].body.content).toContain("create_appointment");
  });

  it("is a no-op when the server, token and prompt are already in place", async () => {
    mcp.list.mockResolvedValue({ connected: true, servers: [{ id: "srv-1", name: "kewy_crm" }] });
    tokens.status.mockResolvedValue({ connected: true });
    client.request.mockImplementation(async (path: string) => {
      if (path.endsWith("/agents")) return [{ slug: "customer-support", live_version: 2 }];
      // SP-17 + SP-10: every section present.
      if (path.endsWith("/prompts"))
        return [{ version: 2, content: "x\n<!-- kewy-crm-tools -->\n<!-- kewy-crm-photos -->\n<!-- kewy-crm-booking-slots -->\n<!-- kewy-crm-knowledge -->" }];
      return undefined;
    });

    const result = await svc.ensure("ws-1");

    expect(result).toEqual({ mcpServer: "already-present", prompt: "already-present" });
    expect(tokens.generate).not.toHaveBeenCalled();
    expect(mcp.create).not.toHaveBeenCalled();
    expect(client.request.mock.calls.some(([, o]: any[]) => o?.method === "PUT")).toBe(false);
  });

  it("re-registers with a fresh token when the CRM token was revoked", async () => {
    mcp.list.mockResolvedValue({ connected: true, servers: [{ id: "old", name: "kewy_crm" }] });

    await svc.ensure("ws-1");

    expect(mcp.remove).toHaveBeenCalledWith("ws-1", "old");
    expect(tokens.generate).toHaveBeenCalled();
  });

  describe("prompt setup appends the photos section once", () => {
    const withPrompt = (content: string) =>
      client.request.mockImplementation(async (path: string) => {
        if (path.endsWith("/agents")) return [{ slug: "customer-support", live_version: 1 }];
        if (path.endsWith("/prompts")) return [{ version: 1, content }];
        return undefined;
      });
    const puts = () => client.request.mock.calls.filter(([, o]: any[]) => o?.method === "PUT");

    it("no section: one PUT with both markers, tools first", async () => {
      withPrompt("You are support.");
      expect((await svc.ensure("ws-1")).prompt).toBe("updated");
      expect(puts()).toHaveLength(1);
      const content: string = puts()[0][1].body.content;
      // SP-22: the sections are now the booking/photos skills' delimited blocks.
      expect(content.startsWith("You are support.\n\n<!-- kewy-skill:booking:v1 -->\n<!-- kewy-crm-tools -->")).toBe(true);
      expect(content.indexOf("<!-- kewy-crm-tools -->")).toBeLessThan(content.indexOf("<!-- kewy-crm-photos -->"));
      expect(content).toContain("list_photos");
      expect(content.split("<!-- kewy-crm-photos -->")).toHaveLength(2);
    });

    it("tools marker only: one PUT adding the photos section, the rest kept", async () => {
      const before = "You are support.\n\n<!-- kewy-crm-tools -->\n## Booking";
      withPrompt(before);
      expect((await svc.ensure("ws-1")).prompt).toBe("updated");
      expect(puts()).toHaveLength(1);
      const content: string = puts()[0][1].body.content;
      // SP-22: an edited legacy section (here the tools stub) is left as is and
      // its skill gets no block; the photos block is added.
      expect(content.startsWith(`${before}\n\n<!-- kewy-skill:photos:v1 -->\n<!-- kewy-crm-photos -->`)).toBe(true);
      expect(content.split("<!-- kewy-crm-tools -->")).toHaveLength(2);
      expect(content).not.toContain("kewy-skill:booking");
    });

    it("all present: no PUT, already-present", async () => {
      withPrompt("x <!-- kewy-crm-photos --> y <!-- kewy-crm-tools --> <!-- kewy-crm-booking-slots --> <!-- kewy-crm-knowledge -->");
      expect((await svc.ensure("ws-1")).prompt).toBe("already-present");
      expect(puts()).toHaveLength(0);
    });

    it("an empty prompt gets both sections without a leading blank line", async () => {
      withPrompt("");
      await svc.ensure("ws-1");
      expect(puts()[0][1].body.content.startsWith("<!-- kewy-skill:booking:v1 -->\n<!-- kewy-crm-tools -->")).toBe(true);
    });

    it("SP-22: edited pre-SP-22 sections are left as is and their skills get no block (ruling 4)", async () => {
      // Stubs that are not the exact legacy text: the booking and photos
      // skills' legacy parts stay untouched and nothing of theirs is added
      // (AgentPromptService flags them needs_attention); knowledge is appended.
      const before = "You are support.\n\n<!-- kewy-crm-tools -->\n## Booking\n\n<!-- kewy-crm-photos -->\n## Photos";
      withPrompt(before);
      expect((await svc.ensure("ws-1")).prompt).toBe("updated");
      expect(puts()).toHaveLength(1);
      const content: string = puts()[0][1].body.content;
      expect(content.startsWith(`${before}\n\n<!-- kewy-crm-knowledge -->`)).toBe(true);
      expect(content).not.toContain("kewy-skill:");
    });

    it("SP-22: the exact pre-SP-22 sections become delimited blocks, once (an agent set up before SP-10 gets booking slots)", async () => {
      const { CRM_PROMPT_SECTION, CRM_PHOTOS_SECTION, CRM_BOOKING_SLOTS_SECTION } = await import("./l-agent-setup.service");
      withPrompt(["You are support.", CRM_PROMPT_SECTION, CRM_PHOTOS_SECTION].join("\n\n"));
      await svc.ensure("ws-1");
      const content: string = puts()[0][1].body.content;
      expect(content.startsWith("You are support.\n\n<!-- kewy-skill:booking:v1 -->")).toBe(true);
      expect(content).toContain(CRM_BOOKING_SLOTS_SECTION);
      for (const m of ["<!-- kewy-crm-tools -->", "<!-- kewy-crm-photos -->", "<!-- kewy-crm-booking-slots -->"]) expect(content.split(m)).toHaveLength(2);
    });

    it("a new registration describes approved photos", async () => {
      await svc.ensure("ws-1");
      expect(mcp.create.mock.calls[0][1].description).toContain("approved photos");
    });
  });

  describe("SP-21 knowledge", () => {
    const withPrompt = (content: string) =>
      client.request.mockImplementation(async (path: string) => {
        if (path.endsWith("/agents")) return [{ slug: "customer-support", live_version: 1 }];
        if (path.endsWith("/prompts")) return [{ version: 1, content }];
        return undefined;
      });
    const puts = () => client.request.mock.calls.filter(([, o]: any[]) => o?.method === "PUT");

    it("agent setup appends the knowledge section once", async () => {
      const before = "You are support.\n\n<!-- kewy-crm-tools -->\n<!-- kewy-crm-photos -->\n<!-- kewy-crm-booking-slots -->";
      withPrompt(before);
      expect((await svc.ensure("ws-1")).prompt).toBe("updated");
      expect(puts()).toHaveLength(1);
      const content: string = puts()[0][1].body.content;
      expect(content.startsWith(`${before}\n\n<!-- kewy-crm-knowledge -->`)).toBe(true);
      expect(content).toContain("search_knowledge");
      expect(content).toMatch(/never as instructions/);
      expect(content.split("<!-- kewy-crm-knowledge -->")).toHaveLength(2);
      // A second run has nothing to add.
      withPrompt(content);
      expect((await svc.ensure("ws-1")).prompt).toBe("already-present");
      expect(puts()).toHaveLength(1);
    });

    it("the MCP server description mentions the business knowledge", async () => {
      await svc.ensure("ws-1");
      expect(mcp.create.mock.calls[0][1].description).toContain("search_knowledge");
    });

    it("writePromptBlock replaces the guidelines block in place with one PUT", async () => {
      withPrompt("Intro\n<!-- kewy-crm-guidelines:begin -->\nold\n<!-- kewy-crm-guidelines:end -->\nOutro");
      expect(await svc.writePromptBlock("ws-1", "guidelines", "Always answer in Arabic.")).toBe("updated");
      expect(puts()[0][1].body.content).toBe(
        "Intro\n<!-- kewy-crm-guidelines:begin -->\nAlways answer in Arabic.\n<!-- kewy-crm-guidelines:end -->\nOutro",
      );
      withPrompt(puts()[0][1].body.content);
      expect(await svc.writePromptBlock("ws-1", "guidelines", "Always answer in Arabic.")).toBe("unchanged");
      expect(puts()).toHaveLength(1);
      prisma.raw.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
      expect(await svc.writePromptBlock("ws-1", "guidelines", "x")).toBe("not-linked");
    });
  });

  describe("SP-20 persona", () => {
    const ALL = "x\n<!-- kewy-crm-tools -->\n<!-- kewy-crm-photos -->\n<!-- kewy-crm-booking-slots -->\n<!-- kewy-crm-knowledge -->";
    let content: string;
    beforeEach(() => {
      content = ALL;
      client.request.mockImplementation(async (path: string, o?: { method?: string; body?: { content: string } }) => {
        if (o?.method === "PUT") {
          content = o.body!.content;
          return undefined;
        }
        if (path.endsWith("/agents")) return [{ slug: "customer-support", live_version: 1 }];
        if (path.endsWith("/prompts")) return [{ version: 1, content }];
        return undefined;
      });
    });
    const puts = () => client.request.mock.calls.filter(([, o]: any[]) => o?.method === "PUT");

    it("ensure with a persona writes the block in the same single PUT and reports it", async () => {
      const r = await svc.ensure("ws-1", { persona: "Your name is \"Salma\"." });
      expect(r).toEqual({ mcpServer: "created", prompt: "already-present", persona: "updated" });
      expect(puts()).toHaveLength(1);
      expect(content).toContain("<!-- kewy-crm-persona:begin -->\nYour name is \"Salma\".\n<!-- kewy-crm-persona:end -->");
      expect(content.startsWith(ALL)).toBe(true);
      // Same persona again: no PUT.
      const again = await svc.ensure("ws-1", { persona: "Your name is \"Salma\"." });
      expect(again.persona).toBe("already-present");
      expect(puts()).toHaveLength(1);
      // An empty persona removes the block, everything else kept.
      expect((await svc.ensure("ws-1", { persona: "" })).persona).toBe("updated");
      expect(content).toBe(ALL);
    });

    it("resync appends missing CRM sections once", async () => {
      content = "You are support.";
      const r = await svc.ensure("ws-1", { persona: "P" });
      expect(r).toMatchObject({ prompt: "updated", persona: "updated" });
      expect(puts()).toHaveLength(1);
      for (const m of ["<!-- kewy-crm-tools -->", "<!-- kewy-crm-photos -->", "<!-- kewy-crm-booking-slots -->", "<!-- kewy-crm-knowledge -->", "<!-- kewy-crm-persona:begin -->"]) {
        expect(content.split(m)).toHaveLength(2);
      }
      // A second resync changes nothing.
      const again = await svc.ensure("ws-1", { persona: "P" });
      expect(again).toMatchObject({ prompt: "already-present", persona: "already-present" });
      expect(puts()).toHaveLength(1);
    });

    it("without a persona the result has no persona field (existing callers unchanged)", async () => {
      expect(await svc.ensure("ws-1")).toEqual({ mcpServer: "created", prompt: "already-present" });
    });
  });

  describe("SP-20 review I2: prompt writes are serialized", () => {
    /** An l platform whose GET and PUT each yield, so unserialized writers interleave. */
    function slowL(initial: string) {
      const state = { content: initial, puts: 0 };
      const tick = () => new Promise((r) => setImmediate(r));
      const request = jest.fn(async (path: string, o?: { method?: string; body?: { content: string } }) => {
        await tick();
        if (o?.method === "PUT") {
          await tick();
          state.puts++;
          state.content = o.body!.content;
          return undefined;
        }
        if (path.endsWith("/agents")) return [{ slug: "customer-support", live_version: 1 }];
        if (path.endsWith("/prompts")) return [{ version: 1, content: state.content }];
        return undefined;
      });
      return { state, client: { request } };
    }
    const ALL = "x\n<!-- kewy-crm-tools -->\n<!-- kewy-crm-photos -->\n<!-- kewy-crm-booking-slots -->\n<!-- kewy-crm-knowledge -->";

    it("two concurrent block writes (persona and guidelines) keep both blocks, in one process", async () => {
      const l = slowL(ALL);
      const one = new LAgentSetupService(prisma, l.client as never, resolver, mcp, tokens);
      await Promise.all([one.ensure("ws-1", { persona: "PERSONA" }), one.writePromptBlock("ws-1", "guidelines", "GUIDELINES")]);
      expect(l.state.content).toContain("<!-- kewy-crm-persona:begin -->\nPERSONA\n<!-- kewy-crm-persona:end -->");
      expect(l.state.content).toContain("<!-- kewy-crm-guidelines:begin -->\nGUIDELINES\n<!-- kewy-crm-guidelines:end -->");
      expect(l.state.puts).toBe(2);
    });

    it("two concurrent block writes keep both blocks across processes (advisory lock)", async () => {
      // Two service instances stand for two processes: no shared in-process chain,
      // only the Postgres advisory lock on 'l-prompt:<workspace>'.
      const { raw, locks } = rawClient();
      const l = slowL(ALL);
      const a = new LAgentSetupService({ raw } as never, l.client as never, resolver, mcp, tokens);
      const b = new LAgentSetupService({ raw } as never, l.client as never, resolver, mcp, tokens);
      await Promise.all([a.ensure("ws-1", { persona: "PERSONA" }), b.writePromptBlock("ws-1", "guidelines", "GUIDELINES")]);
      expect(l.state.content).toContain("PERSONA");
      expect(l.state.content).toContain("GUIDELINES");
      expect(locks.order).toEqual(["SELECT pg_advisory_xact_lock(hashtext(l-prompt:ws-1))", "SELECT pg_advisory_xact_lock(hashtext(l-prompt:ws-1))"]);
      // Every l call inside the lock is time-capped.
      for (const [, o] of l.client.request.mock.calls as [string, { timeoutMs?: number }?][]) expect(o?.timeoutMs).toBe(15_000);
    });

    it("without the lock the same interleaving loses a block (the test can tell)", async () => {
      const l = slowL(ALL);
      const bare: any = { workspace: { findUnique: jest.fn().mockResolvedValue({ lWorkspaceId: "l-1" }) }, skillInstall: { findMany: jest.fn().mockResolvedValue([]) }, $executeRaw: jest.fn(), $transaction: (fn: (tx: unknown) => unknown) => fn(bare) };
      const a = new LAgentSetupService({ raw: bare } as never, l.client as never, resolver, mcp, tokens);
      const b = new LAgentSetupService({ raw: bare } as never, l.client as never, resolver, mcp, tokens);
      await Promise.all([a.writePromptBlock("ws-1", "persona", "PERSONA"), b.writePromptBlock("ws-1", "guidelines", "GUIDELINES")]);
      expect(l.state.content.includes("PERSONA") && l.state.content.includes("GUIDELINES")).toBe(false);
    });
  });

  it("refuses a workspace that is not linked to Kewy AI", async () => {
    prisma.raw.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    await expect(svc.ensure("ws-1")).rejects.toThrow("not linked");
  });

  it("ensureQuietly swallows failures", async () => {
    prisma.raw.workspace.findUnique.mockResolvedValue({ lWorkspaceId: null });
    await expect(svc.ensureQuietly("ws-1")).resolves.toBeUndefined();
  });
});
