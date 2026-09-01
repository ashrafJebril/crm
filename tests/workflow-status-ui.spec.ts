import { canRetryWorkflowRun, workflowStatusBadge } from "../src/screens/settings/workflows/workflowStatus";

// These helpers are pure UI policy. They live in the frontend but run under the
// existing Jest/ts-jest harness because this repository has no UI test runner.
describe("workflow run UI status semantics", () => {
  it.each([
    ["COMPLETED", "ok"],
    ["PARTIAL_FAILED", "bad"],
    ["FAILED", "bad"],
    ["BLOCKED_KILL_SWITCH", "warn"],
    ["BLOCKED_BY_TEST_ALLOWLIST", "warn"],
  ] as const)("maps %s to the %s badge", (status, kind) => {
    expect(workflowStatusBadge(status)).toBe(kind);
  });

  it.each([
    ["COMPLETED", false],
    ["PARTIAL_FAILED", true],
    ["FAILED", true],
    ["BLOCKED_KILL_SWITCH", true],
  ] as const)("sets retry eligibility for %s to %s", (status, eligible) => {
    expect(canRetryWorkflowRun(status)).toBe(eligible);
  });
});
