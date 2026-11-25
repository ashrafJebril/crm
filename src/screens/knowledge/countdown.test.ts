import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import { countdownText } from "./countdown";
import { cooldownSeconds } from "./knowledgeErrors";
import { blockedDetail } from "./WebsitePages";

describe("refresh cooldown and page details", () => {
  it("counts down from the 409 retryAfterSeconds", () => {
    const err = new ApiError("x", 409, undefined, { message: "knowledge.cooldown", retryAfterSeconds: 3599 });
    expect(cooldownSeconds(err)).toBe(3599);
    expect(countdownText(3599)).toBe("59:59");
    expect(countdownText(3600)).toBe("1:00:00");
    expect(countdownText(61.2)).toBe("1:02");
    expect(countdownText(0)).toBe("0:00");
    expect(cooldownSeconds(new ApiError("x", 409, undefined, { message: "knowledge.syncing" }))).toBeNull();
  });

  it("blocked pages show a generic label, with the HTTP status when it explains it", () => {
    const en = makeTx("en");
    expect(blockedDetail({ state: "blocked", httpStatus: null }, en)).toBeNull();
    expect(blockedDetail({ state: "blocked", httpStatus: 302 }, en)).toBe("Redirects off the site");
    expect(blockedDetail({ state: "blocked", httpStatus: 451 }, makeTx("ar"))).toMatch(/451/);
    expect(blockedDetail({ state: "synced", httpStatus: 200 }, en)).toBeNull();
  });
});
