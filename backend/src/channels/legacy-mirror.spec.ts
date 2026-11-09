import * as fs from "fs";
import * as path from "path";
import { channelFromIntegration, ensureLegacyChannels, initcap } from "./legacy-mirror";
import { makeFakePrisma } from "./test-prisma";

const MIGRATION = path.resolve(
  __dirname,
  "../../prisma/migrations/20261112120000_channels/migration.sql",
);
const sql = () => fs.readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
/** SQL without `--` comments, so prose can't satisfy or break an assertion. */
const code = () =>
  sql()
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");

const integ = (over: Record<string, unknown> = {}) => ({
  id: "int1",
  workspaceId: "ws1",
  platform: "whatsapp",
  provider: "zernio",
  pageId: "acc-1",
  pageName: "Shop WhatsApp",
  createdAt: new Date("2026-01-02T03:04:05Z"),
  ...over,
});

describe("migration maps each Integration to one Channel", () => {
  it("SQL backfill is deterministic, guarded and rerunnable", () => {
    const s = code();
    expect(s).toContain(`'chi_' || i."id"`);
    expect(s).toContain("ON CONFLICT DO NOTHING");
    expect(s).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM "Channel" c WHERE c\."integrationId" = i\."id"\)/);
    // default-per-kind guard
    expect(s).toMatch(
      /NOT EXISTS \(SELECT 1 FROM "Channel" d WHERE d\."workspaceId" = i\."workspaceId" AND d\."kind" = lower\(i\."platform"\) AND d\."isDefault"\)/,
    );
    // conversation backfill only fills nulls
    expect(s).toMatch(/UPDATE "Conversation" cv[\s\S]*WHERE cv\."channelId" IS NULL/);
    expect(s).toContain(`COALESCE(NULLIF(i."pageName", ''), initcap(i."platform"))`);
  });

  it("SQL never alters Integration, drops anything or parses raw", () => {
    const s = code();
    expect(s).not.toMatch(/ALTER TABLE "Integration"/i);
    expect(s).not.toMatch(/\bDROP\b/i);
    expect(s).not.toMatch(/raw"?\s*::\s*jsonb?/i);
    expect(s).not.toMatch(/"raw"/);
  });

  it("SQL is additive and idempotent with Prisma-conformant names", () => {
    const s = code();
    expect(s).toContain(`CREATE TABLE IF NOT EXISTS "Channel"`);
    expect(s).toContain(`ADD COLUMN IF NOT EXISTS "channelId"`);
    expect(s).toContain(`ADD COLUMN IF NOT EXISTS "senderChannelId"`);
    for (const name of [
      "Channel_pkey",
      "Channel_workspaceId_fkey",
      "Channel_integrationId_fkey",
      "Channel_integrationId_key",
      "Channel_workspaceId_provider_externalId_key",
      "Channel_workspaceId_kind_idx",
      "Channel_provider_externalId_idx",
      "Conversation_channelId_fkey",
      "Conversation_workspaceId_channelId_idx",
      "Campaign_senderChannelId_fkey",
    ]) {
      expect(s).toContain(`"${name}"`);
    }
    expect(s).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "Channel_one_default_per_kind" ON "Channel"\("workspaceId", ?"kind"\) WHERE "isDefault"/,
    );
    // every index is IF NOT EXISTS, every FK inside a duplicate_object block
    for (const line of s.split("\n").filter((l) => /CREATE (UNIQUE )?INDEX/.test(l))) {
      expect(line).toContain("IF NOT EXISTS");
    }
    const fks = s.match(/ADD CONSTRAINT/g) ?? [];
    const guarded = s.match(/DO \$\$ BEGIN\s+ALTER TABLE "\w+" ADD CONSTRAINT[\s\S]*?EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;/g) ?? [];
    expect(fks.length).toBe(4); // Channel x2, Conversation, Campaign
    expect(guarded.length).toBe(fks.length);
  });

  it("the partial default index is not declared in schema.prisma", () => {
    const schema = fs.readFileSync(path.resolve(__dirname, "../../prisma/schema.prisma"), "utf8");
    expect(schema).not.toMatch(/@@unique\(\[workspaceId, kind\]/);
  });

  it("channelFromIntegration mirrors the SQL mapping", () => {
    expect(channelFromIntegration(integ())).toEqual({
      id: "chi_int1",
      workspaceId: "ws1",
      kind: "whatsapp",
      provider: "zernio",
      externalId: "acc-1",
      displayName: "Shop WhatsApp",
      status: "active",
      integrationId: "int1",
      createdAt: new Date("2026-01-02T03:04:05Z"),
    });
    // NULLIF('') → initcap(platform); lower(platform); provider verbatim
    const legacy = channelFromIntegration(integ({ platform: "Facebook", pageName: "", provider: "kapso", pageId: null }));
    expect(legacy).toMatchObject({ kind: "facebook", displayName: "Facebook", provider: "kapso", externalId: null });
    expect(channelFromIntegration(integ({ pageName: null })).displayName).toBe("Whatsapp");
  });

  it("initcap matches Postgres word rules", () => {
    expect(initcap("whatsapp")).toBe("Whatsapp");
    expect(initcap("tik_tok")).toBe("Tik_Tok");
    expect(initcap("SNAPCHAT")).toBe("Snapchat");
    expect(initcap("x2y")).toBe("X2y");
  });

  it("ensureLegacyChannels creates one channel per integration, then nothing", async () => {
    const prisma = makeFakePrisma({
      integration: [
        integ({ id: "i-wa", platform: "whatsapp", provider: "zernio", pageId: "z-wa" }),
        integ({ id: "i-fb", platform: "facebook", provider: "meta", pageId: "page-1", pageName: "Page" }),
        integ({ id: "i-ig", platform: "instagram", provider: "zernio", pageId: "z-ig", pageName: null }),
      ],
    });
    expect(await ensureLegacyChannels(prisma, "ws1")).toBe(3);
    expect(prisma.db.channel.map((c: { id: string }) => c.id).sort()).toEqual(["chi_i-fb", "chi_i-ig", "chi_i-wa"]);
    expect(prisma.db.channel.every((c: { isDefault: boolean }) => c.isDefault)).toBe(true);
    expect(await ensureLegacyChannels(prisma, "ws1")).toBe(0);
    expect(prisma.db.channel).toHaveLength(3);
    // the no-op path is one query
    prisma.integration.findMany.mockClear();
    prisma.channel.create.mockClear();
    await ensureLegacyChannels(prisma, "ws1");
    expect(prisma.integration.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.channel.create).not.toHaveBeenCalled();
  });

  it("ensureLegacyChannels links an existing channel of the same account instead of duplicating", async () => {
    const prisma = makeFakePrisma({
      integration: [integ({ id: "i-wa", pageId: "z-wa" })],
      channel: [
        {
          id: "ch-sync",
          workspaceId: "ws1",
          kind: "whatsapp",
          provider: "zernio",
          externalId: "z-wa",
          displayName: "x",
          status: "active",
          isDefault: true,
          integrationId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    await ensureLegacyChannels(prisma, "ws1");
    expect(prisma.db.channel).toHaveLength(1);
    expect(prisma.db.channel[0].integrationId).toBe("i-wa");
  });

  it("a second integration of a kind that already has a default is not default", async () => {
    const prisma = makeFakePrisma({
      integration: [integ({ id: "i-wa", pageId: "z-wa" })],
      channel: [
        {
          id: "ch-other",
          workspaceId: "ws1",
          kind: "whatsapp",
          provider: "meta",
          externalId: "pn-9",
          displayName: "x",
          status: "active",
          isDefault: true,
          integrationId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    await ensureLegacyChannels(prisma, "ws1");
    expect(prisma.db.channel.find((c: { id: string }) => c.id === "chi_i-wa").isDefault).toBe(false);
  });
});
