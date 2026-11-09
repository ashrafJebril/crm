import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import { CAMPAIGN_ERROR_COPY, campaignErrorText, partialGroup, partialGroupText } from "./campaignErrors";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;

// Every key in backend campaign-errors.ts plus the messages passed through from
// the segments, tags and group services (task-2 report).
const KEYS = [
  "campaigns.not_found",
  "campaigns.recipient_not_found",
  "campaigns.invalid_cursor",
  "campaigns.invalid_status",
  "campaigns.invalid_limit",
  "campaigns.ids_too_many",
  "campaigns.follow_up_target",
  "campaigns.follow_up_too_large",
  "campaigns.group_name_required",
  "Segment not found",
  "Members can only be managed on manual groups",
  "Tag not found",
  "Group name must be 1-120 characters",
];

describe("campaignErrorText", () => {
  it("maps every error key to copy in both languages", () => {
    expect(Object.keys(CAMPAIGN_ERROR_COPY).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) {
      const err = new ApiError(key, 400, undefined, { statusCode: 400, message: key });
      const e = campaignErrorText(err, en);
      const a = campaignErrorText(err, ar);
      expect(e, key).not.toBe(key);
      expect(e, key).not.toMatch(ARABIC);
      expect(a, key).toMatch(ARABIC);
    }
  });

  it("reads limit and count extras", () => {
    const tooLarge = new ApiError("campaigns.follow_up_too_large", 400, undefined, {
      message: "campaigns.follow_up_too_large",
      limit: 10000,
      count: 12345,
    });
    // `count` is a lower bound only (the scan stops early): quote the limit, never the count.
    expect(campaignErrorText(tooLarge, en)).toContain("more than 10,000 contacts");
    expect(campaignErrorText(tooLarge, en)).not.toContain("12,345");
    expect(campaignErrorText(tooLarge, ar)).toContain("أكثر من 10,000 جهة اتصال");
    const many = new ApiError("campaigns.ids_too_many", 400, undefined, { message: "campaigns.ids_too_many", limit: 5000 });
    expect(campaignErrorText(many, en)).toContain("5,000");
  });

  it("shows the shared no-permission copy on 403", () => {
    const err = new ApiError("Missing permission", 403);
    expect(campaignErrorText(err, en)).toBe("You don't have permission to do this");
    expect(campaignErrorText(err, ar)).toBe("ليست لديك صلاحية للقيام بذلك");
  });

  it("falls back for unknown errors", () => {
    expect(campaignErrorText(new ApiError("HTTP 500", 500), en)).toBe("Something went wrong. Try again.");
    expect(campaignErrorText(new Error("boom"), ar)).toMatch(ARABIC);
    // A Nest validation array joined by the client keeps its first key.
    expect(campaignErrorText(new ApiError("campaigns.invalid_status, campaigns.ids_too_many", 400), en)).toBe(
      campaignErrorText(new ApiError("campaigns.invalid_status", 400), en),
    );
  });

  it("recognises a create-group that made the group before failing", () => {
    const err = new ApiError("campaigns.follow_up_too_large", 400, undefined, {
      message: "campaigns.follow_up_too_large",
      groupId: "g1",
      added: 1000,
    });
    expect(partialGroup(err)).toEqual({ groupId: "g1", added: 1000 });
    expect(partialGroupText({ added: 1000 }, en)).toBe("Group created with 1,000 contacts — use Add to group to finish");
    expect(partialGroupText({ added: 1000 }, ar)).toMatch(ARABIC);
    expect(partialGroup(new ApiError("campaigns.not_found", 404, undefined, { message: "x" }))).toBeNull();
    expect(partialGroup(new Error("x"))).toBeNull();
  });
});
