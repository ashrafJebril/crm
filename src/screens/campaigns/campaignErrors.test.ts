import { describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { makeTx } from "@/lib/tx";
import { CAMPAIGN_ERROR_COPY, campaignErrorText, lastErrorText, partialGroup, partialGroupText } from "./campaignErrors";

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

// Every SP-13 key in backend campaign-errors.ts (task-1 and task-2 reports), plus channels.sender_invalid.
const SP13_KEYS = [
  "campaigns.whatsapp_not_connected",
  "campaigns.already_launched",
  "campaigns.sender_conflict",
  "campaigns.too_many_senders",
  "campaigns.template_missing_on_number",
  "campaigns.template_check_failed",
  "campaigns.template_not_approved",
  "campaigns.template_unsupported",
  "campaigns.schedule_invalid",
  "campaigns.var_map_invalid",
  "campaigns.var_map_too_varied",
  "campaigns.no_reachable_recipients",
  "campaigns.header_media_schedule_too_far",
  "campaigns.not_cancellable",
  "campaigns.launch_failed",
  "channels.sender_invalid",
  "campaigns.has_live_broadcasts",
];

describe("campaignErrorText", () => {
  it("maps every error key to copy in both languages", () => {
    expect(Object.keys(CAMPAIGN_ERROR_COPY).sort()).toEqual([...KEYS, ...SP13_KEYS].sort());
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

  it("campaign error copy covers every SP-13 key in both languages", () => {
    // Launch-step keys, plus the media and template-header keys the launch passes through.
    const all = [
      ...SP13_KEYS,
      "media.too_large",
      "media.in_use",
      "templates.header_media_too_large",
      "templates.header_media_mismatch",
      "templates.header_media_required",
      "Media not found",
    ];
    for (const key of all) {
      const err = new ApiError(key, 400, undefined, { statusCode: 400, message: key });
      const e = campaignErrorText(err, en);
      const a = campaignErrorText(err, ar);
      expect(e, key).not.toBe(key);
      expect(e, key).not.toBe("Something went wrong. Try again.");
      expect(e, key).not.toMatch(ARABIC);
      expect(a, key).toMatch(ARABIC);
    }
    const gate = new ApiError("campaigns.whatsapp_not_connected", 409, "WHATSAPP_NOT_CONNECTED");
    expect(campaignErrorText(gate, en)).toBe(
      "WhatsApp isn't connected. Connect a number in Channels to send campaigns and submit templates.",
    );
  });

  it("names the numbers missing the template, isolated left to right", () => {
    const senders = [
      { channelId: "c1", displayName: "Sales", phoneNumber: "+962790000001" },
      { channelId: "c2", displayName: "Support", phoneNumber: "+962790000002" },
    ];
    const one = new ApiError("campaigns.template_missing_on_number", 400, undefined, {
      message: "campaigns.template_missing_on_number",
      channelIds: ["c2"],
    });
    expect(campaignErrorText(one, en, { senders })).toBe(
      "The template isn't approved on Support · \u2066+962790000002\u2069. Remove that number or get the template approved there.",
    );
    expect(campaignErrorText(one, ar, { senders })).toContain("\u2066+962790000002\u2069");
    // An id the page doesn't know: the general sentence, never a raw id.
    const unknown = new ApiError("campaigns.template_missing_on_number", 400, undefined, { channelIds: ["zz"] });
    expect(campaignErrorText(unknown, en, { senders })).not.toContain("zz");
    const many = new ApiError("campaigns.too_many_senders", 400, undefined, { limit: 3 });
    expect(campaignErrorText(many, en)).toBe("Your plan allows up to 3 numbers per campaign.");
    const varMap = new ApiError("campaigns.var_map_invalid", 400, undefined, { slot: "2", reason: "empty_value" });
    expect(campaignErrorText(varMap, en)).toBe("Enter the fixed value for {{2}}.");
    expect(campaignErrorText(varMap, ar)).toMatch(ARABIC);
    const varied = new ApiError("campaigns.var_map_too_varied", 400, undefined, {
      partitions: 40,
      limit: 25,
      directLimit: 5000,
      reachable: 9000,
    });
    expect(campaignErrorText(varied, en)).toContain("40 different messages");
    expect(campaignErrorText(varied, en)).toContain("5,000");
  });

  it("words a stored lastError key and keeps an older provider message", () => {
    expect(lastErrorText("campaigns.no_reachable_recipients", en)).toBe(
      "No one in the audience could receive it: no usable number, opted out, or a missing value without a fallback.",
    );
    expect(lastErrorText("campaigns.launch_failed", ar)).toMatch(ARABIC);
    expect(lastErrorText("Zernio said no", en)).toBe("Zernio said no");
    expect(lastErrorText(null, en)).toBeNull();
    expect(lastErrorText("  ", en)).toBeNull();
  });
});
