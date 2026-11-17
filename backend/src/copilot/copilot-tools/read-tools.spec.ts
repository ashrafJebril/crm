/* eslint-disable @typescript-eslint/no-explicit-any */
import { AGENT, NOW, OWNER, VIEWER, WS, WS2, copilotWorld, viewer } from "../copilot-test-world";
import { SourceCollector } from "../copilot-sources";
import type { ToolContext } from "./registry";

/** Run one tool directly as a member (the turn loop's permission check is covered in the turn spec). */
function ctxFor(userId: string, ws = WS) {
  const sources = new SourceCollector();
  const emitted: Array<[string, unknown]> = [];
  let tainted = false;
  const ctx: ToolContext = {
    workspaceId: ws,
    viewer: viewer(userId),
    sessionId: "s1",
    lang: "en",
    now: NOW,
    sources,
    taint: () => (tainted = true),
    emit: (e, d) => emitted.push([e, d]),
  };
  return { ctx, sources, emitted, tainted: () => tainted };
}

describe("copilot read tools", () => {
  it("registry: the read tool set, sorted", () => {
    const w = copilotWorld();
    expect(w.registry.names()).toEqual([
      "draft_reply",
      "get_booking",
      "get_campaign",
      "get_contact",
      "get_conversation",
      "get_ticket",
      "list_campaigns",
      "search_bookings",
      "search_contacts",
      "search_conversations",
      "search_knowledge",
      "search_tickets",
      "summarize_insights",
    ]);
    const w2 = copilotWorld({ knowledge: false, insights: false });
    expect(w2.registry.names()).not.toContain("search_knowledge");
    expect(w2.registry.names()).not.toContain("summarize_insights");
    // Every tool is a read tool with at least one permission.
    for (const n of w.registry.names()) {
      const t = w.registry.get(n)!;
      expect({ n, kind: t.kind, perms: t.permissions.length > 0 }).toEqual({ n, kind: "read", perms: true });
    }
  });

  it("search_contacts goes through SearchService as the member", async () => {
    const w = copilotWorld();
    const c = ctxFor(AGENT);
    const out: any = await w.registry.get("search_contacts")!.execute(c.ctx, { query: "lay", limit: 5 } as never);
    expect(w.search.search).toHaveBeenCalledWith(WS, "lay", 5, { userId: AGENT, bypass: false });
    expect(out.contacts.map((x: any) => x.id)).toEqual(["c-layla"]);
  });

  it("get_contact / get_booking / get_ticket read through RecordsService and add a source card", async () => {
    const w = copilotWorld();
    const c = ctxFor(OWNER);
    expect(await w.registry.get("get_contact")!.execute(c.ctx, { id: "c-layla" } as never)).toMatchObject({ kind: "contact", id: "c-layla", title: "Layla" });
    expect(await w.registry.get("get_booking")!.execute(c.ctx, { id: "b1" } as never)).toMatchObject({ kind: "booking", id: "b1", title: "Cut" });
    expect(await w.registry.get("get_ticket")!.execute(c.ctx, { id: "t-hidden" } as never)).toMatchObject({ kind: "ticket", id: "t-hidden" });
    // Another workspace's record or a missing id: not found, and no card.
    expect(await w.registry.get("get_contact")!.execute(c.ctx, { id: "c-foreign" } as never)).toMatchObject({ error: "not_found" });
    expect(await w.registry.get("get_ticket")!.execute(c.ctx, { id: "nope" } as never)).toMatchObject({ error: "not_found" });
    expect(c.sources.list().map((s: any) => s.id)).toEqual(["c-layla", "b1", "t-hidden"]);
  });

  it("search_tickets keeps only tickets the member can open", async () => {
    const w = copilotWorld();
    const c = ctxFor(VIEWER);
    const out: any = await w.registry.get("search_tickets")!.execute(c.ctx, { query: "refund" } as never);
    expect(w.tickets.listTickets).toHaveBeenCalledWith(WS, expect.objectContaining({ q: "refund" }), { userId: VIEWER, bypass: false });
    // The stub returned the foreign workspace's ticket too: dropped.
    expect(out.tickets.map((t: any) => t.id)).toEqual(["t-hidden"]);
  });

  it("search_bookings: a query uses BookingsService.search; otherwise a date range in the workspace", async () => {
    const w = copilotWorld();
    const c = ctxFor(VIEWER);
    await w.registry.get("search_bookings")!.execute(c.ctx, { query: "Layla" } as never);
    expect(w.bookings.search).toHaveBeenCalledWith(WS, "Layla", NOW);
    const out: any = await w.registry.get("search_bookings")!.execute(c.ctx, {} as never);
    expect(out.bookings.map((b: any) => [b.id, b.customer?.name])).toEqual([["b1", "Layla"]]);
    const foreign: any = await w.registry.get("search_bookings")!.execute(ctxFor(VIEWER, WS2).ctx, {} as never);
    expect(foreign.bookings).toEqual([]);
  });

  it("campaigns: list and one campaign, within the workspace", async () => {
    const w = copilotWorld({
      seed: (s) => {
        (s.campaign as any[]).push(
          { id: "k1", workspaceId: WS, name: "Eid offer", channel: "whatsapp", status: "sent", sent: 10, delivered: 9, read: 5, failed: 1, createdAt: NOW, updatedAt: NOW },
          { id: "k2", workspaceId: WS2, name: "Foreign", channel: "whatsapp", status: "sent", sent: 1, delivered: 1, read: 1, failed: 0, createdAt: NOW, updatedAt: NOW },
        );
      },
    });
    const c = ctxFor(VIEWER);
    const list: any = await w.registry.get("list_campaigns")!.execute(c.ctx, {} as never);
    expect(list.campaigns.map((k: any) => k.id)).toEqual(["k1"]);
    expect(await w.registry.get("get_campaign")!.execute(c.ctx, { id: "k1" } as never)).toMatchObject({ kind: "campaign", title: "Eid offer" });
    expect(await w.registry.get("get_campaign")!.execute(c.ctx, { id: "k2" } as never)).toMatchObject({ error: "not_found" });
  });

  it("search_conversations is the member's conversation scope", async () => {
    const w = copilotWorld();
    const agent: any = await w.registry.get("search_conversations")!.execute(ctxFor(AGENT).ctx, {} as never);
    expect(agent.conversations.map((v: any) => v.id)).toEqual(["v-mine"]);
    const owner: any = await w.registry.get("search_conversations")!.execute(ctxFor(OWNER).ctx, {} as never);
    expect(owner.conversations.map((v: any) => v.id)).toEqual(["v-hidden", "v-mine"]);
    const byName: any = await w.registry.get("search_conversations")!.execute(ctxFor(OWNER).ctx, { query: "omar" } as never);
    expect(byName.conversations.map((v: any) => v.id)).toEqual(["v-hidden"]);
    const unassigned: any = await w.registry.get("search_conversations")!.execute(ctxFor(OWNER).ctx, { assignee: "unassigned" } as never);
    expect(unassigned.conversations.map((v: any) => v.id)).toEqual(["v-hidden"]);
    // The agent asking for unassigned ones still gets only their scope.
    const sneaky: any = await w.registry.get("search_conversations")!.execute(ctxFor(AGENT).ctx, { assignee: "unassigned", query: "omar" } as never);
    expect(sneaky.conversations).toEqual([]);
  });
});
