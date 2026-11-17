/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClaudeService } from "../ai/claude.service";
import { buildChatRequest, contextMessage, copilotModel, withoutThinking } from "./copilot-model";
import { COPILOT_SYSTEM, turnContext } from "./copilot-prompt";

describe("copilot-model", () => {
  const claude = new ClaudeService(jest.fn() as never);

  it("copilotModel: COPILOT_MODEL or claude-opus-5-5", () => {
    expect(copilotModel(claude)).toBe("claude-opus-5-5");
    process.env.COPILOT_MODEL = "claude-sonnet-5-5";
    try {
      expect(copilotModel(claude)).toBe("claude-sonnet-5-5");
    } finally {
      delete process.env.COPILOT_MODEL;
    }
  });

  it("buildChatRequest: effort medium, 64k, cached system, auto tool choice, no sampling or thinking, a messages snapshot", () => {
    const messages: any[] = [{ role: "user", content: "hi" }];
    const tools: any[] = [{ name: "a", input_schema: { type: "object" } }];
    const r: any = buildChatRequest(claude, { model: "claude-opus-5-5", system: COPILOT_SYSTEM, tools, messages });
    expect(r).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 64000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: COPILOT_SYSTEM, cache_control: { type: "ephemeral" } }],
      tool_choice: { type: "auto" },
      tools,
    });
    for (const k of ["temperature", "top_p", "top_k", "thinking"]) expect(r).not.toHaveProperty(k);
    messages.push({ role: "assistant", content: "later" });
    expect(r.messages).toHaveLength(1);
  });

  it("contextMessage: a system message on models that take one, else an operator block", () => {
    expect(contextMessage("claude-opus-5-5", "ctx")).toEqual({ system: { role: "system", content: "ctx" } });
    expect(contextMessage("claude-sonnet-4-6", "ctx")).toEqual({ userBlock: { type: "text", text: "[Operator context]\nctx" } });
  });

  it("withoutThinking strips thinking and redacted thinking from assistant turns only", () => {
    const m: any[] = [
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "redacted_thinking", data: "d" }, { type: "text", text: "a" }] },
      { role: "assistant", content: "plain" },
    ];
    expect(withoutThinking(m)).toEqual([m[0], { role: "assistant", content: [{ type: "text", text: "a" }] }, m[2]]);
  });

  it("the system prompt is stable; the per-turn context carries the member, page, refs and taint", () => {
    expect(COPILOT_SYSTEM).toContain("customerWritten");
    expect(COPILOT_SYSTEM).toContain("draft_reply");
    expect(COPILOT_SYSTEM).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const ctx = turnContext({
      lang: "ar",
      member: { name: "Amal", roleName: "وكيل" },
      missingPermissions: ["tickets.view"],
      approvalMode: "manual",
      now: new Date("2026-11-17T10:00:00Z"),
      tz: "Asia/Riyadh",
      page: { page: "ticket", record: { kind: "ticket", id: "t1", title: "#1" }, range: { from: "2026-11-01" } },
      references: [{ kind: "contact", id: "c1", title: "Layla", fields: [{ key: "phone", value: "+9665" }] }],
      tainted: true,
    });
    expect(ctx).toContain("Interface language: Arabic.");
    expect(ctx).toContain("Member: Amal (role: وكيل).");
    expect(ctx).toContain("13:00");
    expect(ctx).toContain("does not include: tickets.view");
    expect(ctx).toContain('open record: ticket t1 "#1"');
    expect(ctx).toContain("range: 2026-11-01 to …");
    expect(ctx).toContain('[{"kind":"contact","id":"c1","title":"Layla","fields":[{"key":"phone","value":"+9665"}]}]');
    expect(ctx).toContain("every change needs the member's approval");
  });
});
