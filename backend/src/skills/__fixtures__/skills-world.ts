/**
 * SP-22 in-memory world for the skills specs (not a runtime file): the REAL
 * SkillsService, AgentPromptService and LAgentSetupService (its editPrompt
 * chain and advisory lock) over the channels/test-prisma double, with a fake
 * l prompt API that counts PUTs and can fail.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { makeFakePrisma, withAdvisoryLocks } from "../../channels/test-prisma";
import { LAgentSetupService } from "../../integrations/l-agent-setup.service";
import { AgentPromptService } from "../agent-prompt.service";
import { SkillsService } from "../skills.service";
import { SKILL_CATALOG, type ConnectorProvider, type SkillCatalog, type SkillEntry } from "../skill-catalog";

export const WS = "ws1";
export const WS2 = "ws2";

export function makeL(initial = "") {
  const state = { content: initial, version: 1, puts: 0, gets: 0, failNext: 0 };
  const request = jest.fn(async (path: string, o?: { method?: string; body?: { content: string } }) => {
    if (o?.method === "PUT") {
      if (state.failNext > 0) {
        state.failNext--;
        throw new Error("l request failed: HTTP 500 (token=abc123)");
      }
      state.puts++;
      state.version++;
      state.content = o.body!.content;
      return undefined;
    }
    if (path.endsWith("/agents")) {
      state.gets++;
      return [{ slug: "agent-1", live_version: state.version }];
    }
    if (path.endsWith("/prompts")) return [{ version: state.version, content: state.content }];
    return undefined;
  });
  return { state, request };
}

export function makeSkillsWorld(opts: { prompt?: string; catalog?: SkillCatalog; linked?: boolean; locks?: boolean } = {}) {
  const prisma: any = makeFakePrisma({
    workspace: [
      { id: WS, name: "Acme", slug: "acme", lWorkspaceId: opts.linked === false ? null : "l-1", lAgentSlug: "agent-1" },
      { id: WS2, name: "Other", slug: "other", lWorkspaceId: "l-2", lAgentSlug: "agent-2" },
    ],
    skillInstall: [],
    agentToolCall: [],
    agentSettings: [],
  } as never);
  prisma.raw = prisma;
  const locks = opts.locks ? withAdvisoryLocks(prisma) : null;
  const l = makeL(opts.prompt ?? "");
  const setup = new LAgentSetupService(
    prisma,
    { request: l.request } as never,
    { resolveSlug: jest.fn().mockResolvedValue("agent-1") } as never,
    {} as never,
    {} as never,
  );
  const prompts = new AgentPromptService(prisma, setup);
  const connected = new Set<ConnectorProvider>();
  const presence = { isConnected: jest.fn(async (_ws: string, p: ConnectorProvider) => connected.has(p)) };
  const skills = new SkillsService(prisma, prompts, presence, opts.catalog ?? SKILL_CATALOG);
  return { prisma, db: prisma.db as Record<string, any[]>, l, setup, prompts, presence, connected, skills, locks };
}

/** A catalog with one entry replaced. */
export function withEntry(key: string, patch: (e: SkillEntry) => SkillEntry): SkillCatalog {
  return SKILL_CATALOG.map((e) => (e.key === key ? patch(e) : e));
}
