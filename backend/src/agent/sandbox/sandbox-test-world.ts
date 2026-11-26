/**
 * SP-20 spec helper (not a runtime file): a sandbox over the in-memory Prisma,
 * the real McpToolsFactory with workspace-scoped stub services, a scripted
 * fake Claude client and fakes for every outside party (l, Zernio, kewy-ai,
 * realtime, workflow events) that record calls and must stay at zero.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotFoundException } from "@nestjs/common";
import { makeFakePrisma } from "../../channels/test-prisma";
import { ClaudeService } from "../../ai/claude.service";
import { fakeClaude } from "../../ai/claude-test-fake";
import { McpToolsFactory } from "../../mcp-server/mcp-tools.factory";
import { LAgentSetupService } from "../../integrations/l-agent-setup.service";
import { AgentReplyGate, invalidateAgentGate } from "../agent-reply-gate";
import { SandboxService } from "./sandbox.service";

export const WS = "ws1";
export const OTHER_WS = "ws2";
export const MEMBER = "u1";

export function seed() {
  return {
    workspace: [
      { id: WS, name: "Salon", slug: "salon", timezone: "Asia/Riyadh", lWorkspaceId: null, lAgentSlug: null },
      { id: OTHER_WS, name: "Other", slug: "other", timezone: "Asia/Riyadh", lWorkspaceId: null, lAgentSlug: null },
    ],
    user: [
      { id: MEMBER, name: "Owner", email: "o@x" },
      { id: "u2", name: "Admin", email: "a@x" },
    ],
    contact: [
      { id: "c1", workspaceId: WS, name: "Sara", phone: "+966500000001", tags: "[]" },
      { id: "c-foreign", workspaceId: OTHER_WS, name: "Someone else", phone: "+966500000009", tags: "[]" },
    ],
    conversation: [{ id: "cv1", workspaceId: WS, contactId: "c1", channel: "whatsapp", aiEnabled: true, aiPausedAt: null }],
    message: [{ id: "m1", workspaceId: WS, conversationId: "cv1", from: "them", body: "hi" }],
    ticket: [],
    appointment: [{ id: "a1", workspaceId: WS, contactId: "c1", service: "Cut", startAt: new Date("2026-11-20T09:00:00Z"), status: "confirmed" }],
    activity: [],
    notification: [],
    media: [],
    knowledgeSource: [
      { id: "ks-guide", workspaceId: WS, kind: "guideline", title: "Guidelines", body: "Always greet warmly.", status: "ready", createdAt: new Date("2026-01-01") },
    ],
    agentSettings: [{ id: "as1", workspaceId: WS, nameEn: "Salma", nameAr: "سلمى", tone: ["friendly"], hoursMode: "always", excludedTagIds: [], version: 1, stoppedAt: null }],
    agentSandboxThread: [],
  };
}

/** Workspace-scoped stub services behind the real factory (reads only read the double). */
export function services(prisma: any) {
  const scoped = (table: string) => (ws: string) => (prisma.db[table] ?? []).filter((r: any) => r.workspaceId === ws);
  const contacts = {
    search: jest.fn(async (ws: string, q: string) => scoped("contact")(ws).filter((c: any) => c.name.includes(q) || c.phone?.includes(q))),
    get: jest.fn(async (ws: string, id: string) => {
      const c = scoped("contact")(ws).find((r: any) => r.id === id);
      if (!c) throw new NotFoundException("Contact not found");
      return c;
    }),
    create: jest.fn(),
    update: jest.fn(),
  };
  const appointments = {
    list: jest.fn(async (ws: string) => scoped("appointment")(ws)),
    get: jest.fn(async (ws: string, id: string) => scoped("appointment")(ws).find((r: any) => r.id === id)),
    create: jest.fn(),
    update: jest.fn(),
  };
  const media = { listForAgent: jest.fn(async () => [{ id: "p1", url: "https://cdn.example.com/p1.jpg", title: "Menu" }]) };
  const bookings = {
    activeServices: jest.fn(async () => [{ id: "s1", name: "Cut" }]),
    availability: jest.fn(async () => ({ serviceId: "s1", date: "2026-11-22", slots: [{ startAt: "2026-11-22T07:00:00.000Z", resourceId: "r1" }] })),
  };
  const knowledge = {
    search: jest.fn(async () => [
      { chunkId: "k1", sourceId: "src-web", sourceTitle: "salon.example", kind: "website", heading: null, text: "We open at 9.", url: "https://salon.example/hours" },
      { chunkId: "k2", sourceId: "src-web", sourceTitle: "salon.example", kind: "website", heading: null, text: "Parking.", url: "https://salon.example/visit" },
      { chunkId: "k3", sourceId: "src-faq", sourceTitle: "Do you take cards?", kind: "faq", heading: null, text: "Yes." },
      { chunkId: "k4", sourceId: "src-bad", sourceTitle: "Bad link", kind: "website", heading: null, text: "x", url: "javascript:alert(1)" },
    ]),
  };
  const factory = new McpToolsFactory(appointments as never, contacts as never, media as never, bookings as never, knowledge as never);
  return { contacts, appointments, media, bookings, knowledge, factory };
}

export type Reply = Record<string, unknown> | ((params: any) => Record<string, unknown>);

/** A fake Claude answering with the scripted replies in order (the last one repeats). */
export function scriptedClaude(replies: Reply[]) {
  let n = 0;
  const fake = fakeClaude((params: any) => {
    const r = replies[Math.min(n++, replies.length - 1)];
    const body = typeof r === "function" ? r(params) : r;
    return { id: `msg_${n}`, type: "message", role: "assistant", model: params.model, content: [], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, ...body };
  });
  return { ...fake, claude: new ClaudeService(fake.factory) };
}

export function toolUse(id: string, name: string, input: unknown) {
  return { type: "tool_use", id, name, input };
}

export function sandboxWorld(
  opts: { replies?: Reply[]; linked?: boolean; seed?: Record<string, unknown[]>; perm?: unknown; lAgent?: unknown } = {},
) {
  invalidateAgentGate();
  const prisma: any = makeFakePrisma({ ...seed(), ...(opts.seed ?? {}) } as never);
  if (opts.linked) Object.assign(prisma.db.workspace[0], { lWorkspaceId: "l-ws", lAgentSlug: "support" });
  const svc = services(prisma);
  const ai = scriptedClaude(opts.replies ?? [{ content: [{ type: "text", text: "Hello!" }] }]);
  // Outside parties: every call recorded, none expected.
  const lClient = {
    request: jest.fn(async (path: string, o?: { method?: string }) => {
      if (o?.method && o.method !== "GET") throw new Error("the sandbox must never write to the agent platform");
      if (path.endsWith("/agents")) return [{ slug: "support", live_version: 3 }];
      if (path.endsWith("/prompts")) return [{ version: 3, content: "LIVE PROMPT\n<!-- kewy-crm-tools -->" }];
      return [];
    }),
  };
  const raw = { workspace: { findUnique: jest.fn(async (a: any) => prisma.db.workspace.find((w: any) => w.id === a.where.id) ?? null) } };
  const lSetup = new LAgentSetupService({ raw } as never, lClient as never, {} as never, {} as never, {} as never);
  const zernioClient = { sendMessage: jest.fn(), sendTemplateMessage: jest.fn() };
  const kewyBridge = { notifyInbound: jest.fn() };
  const realtime = { emitToWorkspace: jest.fn() };
  const events = { emit: jest.fn() };
  const gate = new AgentReplyGate(prisma);
  // The agent's guidelines, as l returns them.
  const knowledge = { getGuidelines: jest.fn(async () => (prisma.db.knowledgeSource ?? []).find((s: any) => s.workspaceId === WS && s.kind === "guideline") ?? null) };
  const sandbox = new SandboxService(prisma, ai.claude, svc.factory, gate, lSetup, opts.perm as never, undefined, opts.lAgent as never, knowledge as never);
  return { prisma, sandbox, ai, lClient, zernioClient, kewyBridge, realtime, events, gate, ...svc };
}

/** Row counts of every table in the double. */
export function counts(prisma: any): Record<string, number> {
  return Object.fromEntries(Object.entries(prisma.db as Record<string, unknown[]>).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
}

export function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  const restore = () => {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  };
  return fn().finally(restore);
}
