import * as C from "./agent-constants";

describe("SP-20 agent constants", () => {
  it("match the plan's Global Constraints", () => {
    expect(C.AGENT_TONES).toEqual(["friendly", "professional", "casual", "concise", "enthusiastic", "serious", "witty"]);
    expect(C.AGENT_TONES).not.toContain("sarcastic"); // ruling 8
    expect(C.HOURS_MODES).toEqual(["always", "within", "outside"]);
    expect(C.PUBLISH_STATES).toEqual(["none", "pending", "published", "failed"]);
    expect([C.AGENT_NAME_MAX, C.GREETING_MAX, C.EXCLUDED_TAGS_MAX, C.STOP_REASON_MAX]).toEqual([60, 500, 50, 500]);
    expect(C.AGENT_GATE_CACHE_MS).toBe(30_000);
    expect(C.PERSONA_BLOCK).toBe("persona");
    expect([C.SANDBOX_MESSAGE_MAX, C.SANDBOX_MAX_TURNS, C.SANDBOX_TTL_MS, C.SANDBOX_TIMEOUT_MS]).toEqual([1000, 40, 86_400_000, 90_000]);
    expect(C.SANDBOX_RATE).toEqual({ turns: 20, windowMs: 600_000 });
    expect([C.SANDBOX_MAX_ITERATIONS, C.SANDBOX_MAX_TOOL_CALLS, C.ANSWERED_FROM_VISIBLE]).toEqual([6, 8, 3]);
    expect(C.SANDBOX_READ_TOOLS).toEqual([
      "list_appointments",
      "get_appointment",
      "list_services",
      "find_slots",
      "search_contacts",
      "get_contact",
      "list_photos",
      "search_knowledge",
    ]);
    expect(C.ONBOARDING_STEPS).toEqual(["business", "website", "learn", "try", "live"]);
    expect(C.ONBOARDING_STATUSES).toEqual(["not_started", "in_progress", "skipped", "done"]);
    expect([C.BUSINESS_NAME_MAX, C.LEARN_PAGES_MAX, C.LEARN_TEXT_MAX, C.LEARN_FAQS_MAX, C.LEARN_SERVICES_MAX]).toEqual([120, 20, 60_000, 20, 30]);
  });
});
