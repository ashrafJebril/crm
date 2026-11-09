import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  AddToGroupDto,
  CreateGroupDto,
  ExportBodyDto,
  ExportQueryDto,
  RecipientsQueryDto,
  TagFollowUpDto,
} from "./campaign-report.dto";

/** Same options as the global ValidationPipe in main.ts. */
async function errors(cls: new () => object, plain: Record<string, unknown>): Promise<string[]> {
  const inst = plainToInstance(cls, plain, { enableImplicitConversion: false });
  const errs = await validate(inst, { whitelist: true, forbidNonWhitelisted: true });
  return errs.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe("campaign report DTOs", () => {
  it("recipients query: status in RECIPIENT_STATUSES, limit 1..200 (string from the URL), cursor string", async () => {
    expect(await errors(RecipientsQueryDto, { status: "read", limit: "200", cursor: "abc" })).toEqual([]);
    expect(await errors(RecipientsQueryDto, {})).toEqual([]);
    expect(await errors(RecipientsQueryDto, { status: "bogus" })).toEqual(["campaigns.invalid_status"]);
    expect(await errors(RecipientsQueryDto, { limit: "500" })).toEqual(["campaigns.invalid_limit"]);
    expect(await errors(RecipientsQueryDto, { limit: "0" })).toEqual(["campaigns.invalid_limit"]);
    expect(plainToInstance(RecipientsQueryDto, { limit: "25" }).limit).toBe(25);
  });

  it("export: lang in en/ar, status checked, ids capped at 10 000", async () => {
    expect(await errors(ExportQueryDto, { status: "failed", lang: "ar" })).toEqual([]);
    expect(await errors(ExportQueryDto, { lang: "fr" })).toHaveLength(1);
    expect(await errors(ExportBodyDto, { ids: ["a", "b"], lang: "en" })).toEqual([]);
    const big = Array.from({ length: 10_001 }, (_, i) => `x${i}`);
    expect(await errors(ExportBodyDto, { ids: big })).toEqual(["campaigns.ids_too_many"]);
    expect(await errors(ExportBodyDto, { ids: "a,b" })).not.toEqual([]);
  });

  it("follow-ups: ids capped at 5 000, name trimmed to 1..120, ids or status", async () => {
    const big = Array.from({ length: 5001 }, (_, i) => `x${i}`);
    expect(await errors(TagFollowUpDto, { ids: big, tagId: "t" })).toEqual(["campaigns.ids_too_many"]);
    expect(await errors(TagFollowUpDto, { status: "read", tagId: "t" })).toEqual([]);
    expect(await errors(TagFollowUpDto, { status: "read" })).not.toEqual([]);
    expect(await errors(AddToGroupDto, { ids: ["r1"], groupId: "g" })).toEqual([]);
    expect(await errors(CreateGroupDto, { status: "read", name: "  ok  ", nameAr: "حسنا" })).toEqual([]);
    expect(plainToInstance(CreateGroupDto, { name: "  ok  " }).name).toBe("ok");
    expect(await errors(CreateGroupDto, { status: "read", name: "   " })).toContain("campaigns.group_name_required");
    expect(await errors(CreateGroupDto, { status: "read", name: "x".repeat(121) })).not.toEqual([]);
    expect(await errors(CreateGroupDto, { status: "read", name: "ok", extra: 1 })).not.toEqual([]);
  });

  it("m3: every CreateGroupDto.name failure carries the campaigns.group_name_required key, never generic text", async () => {
    for (const name of ["   ", "", "x".repeat(121), " " + "x".repeat(121) + " ", undefined, 42, null]) {
      const msgs = await errors(CreateGroupDto, { status: "read", ...(name === undefined ? {} : { name }) });
      expect(msgs.length).toBeGreaterThan(0);
      expect(new Set(msgs)).toEqual(new Set(["campaigns.group_name_required"]));
    }
  });
});
