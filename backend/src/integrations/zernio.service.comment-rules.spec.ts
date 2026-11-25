import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ZernioService } from "./zernio.service";
import { PrismaService } from "../prisma/prisma.service";
import { RealtimeService } from "../realtime/realtime.service";
import { MediaService } from "../media/media.service";
import { ZernioClient } from "./zernio.client";
import { AiBridgeService } from "./ai-bridge.service";

/**
 * Comment auto-reply: the rule is configured here but RUNS AT ZERNIO.
 *
 * That is the whole reason these tests exist. Enabling creates an automation
 * that sends real private DMs and keeps going whether or not this app is up,
 * so the two things that must never break are:
 *   1. a workspace can only ever arm its OWN connected account, and
 *   2. "off" genuinely reaches Zernio — a UI that says paused while DMs keep
 *      going is worse than having no switch at all.
 */
const WS = "ws-1";
const ACCOUNT = "acc-1";

function build(
  opts: {
    rule?: Record<string, unknown> | null;
    ownChannel?: Record<string, unknown> | null;
    profileId?: string | null;
  } = {},
) {
  const rule =
    opts.rule === undefined
      ? {
          id: "rule-1",
          workspaceId: WS,
          platform: "instagram",
          accountId: ACCOUNT,
          automationId: null,
          keywords: JSON.stringify(["كيوي"]),
          matchMode: "contains",
          platformPostId: null,
          dmMessage: "أهلاً! شو نوع محلك؟",
          commentReply: null,
          replyOncePerPerson: true,
          dmDelaySeconds: 0,
          handoffToAgent: true,
          enabled: false,
          enabledAt: null,
          disabledAt: null,
        }
      : opts.rule;

  // A STATEFUL double. Save-then-enable and the edit-a-live-rule path both
  // re-read the row between steps, so a double that always returns the same
  // object would quietly test a sequence that cannot happen.
  const DEFAULTS = {
    id: "rule-1",
    workspaceId: WS,
    accountId: ACCOUNT,
    platform: "instagram",
    automationId: null,
    matchMode: "contains",
    platformPostId: null,
    commentReply: null,
    replyOncePerPerson: true,
    dmDelaySeconds: 0,
    handoffToAgent: true,
    enabled: false,
    enabledAt: null,
    disabledAt: null,
  };
  let current: Record<string, unknown> | null = rule;

  const prisma: any = {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({
        zernioProfileId: opts.profileId === undefined ? "prof-1" : opts.profileId,
      }),
    },
    // ownAccount() looks at Channel first, then the legacy Integration row.
    channel: {
      findFirst: jest.fn().mockResolvedValue(
        opts.ownChannel === undefined
          ? { kind: "instagram", status: "connected" }
          : opts.ownChannel,
      ),
    },
    integration: { findFirst: jest.fn().mockResolvedValue(null) },
    commentAutoReply: {
      findFirst: jest.fn(async () => current),
      findUnique: jest.fn(async () => current),
      findMany: jest.fn(async () => (current ? [current] : [])),
      upsert: jest.fn(async ({ create, update }: any) => {
        current = current
          ? { ...current, ...update }
          : { ...DEFAULTS, ...create };
        return current;
      }),
      update: jest.fn(async ({ data }: any) => {
        current = { ...(current ?? DEFAULTS), ...data };
        return current;
      }),
      delete: jest.fn(async () => {
        const gone = current;
        current = null;
        return gone;
      }),
    },
    commentLead: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const client: any = {
    isConfigured: () => true,
    createCommentAutomation: jest.fn().mockResolvedValue({ id: "auto-1", isActive: true }),
    listCommentAutomations: jest.fn().mockResolvedValue([]),
    updateCommentAutomation: jest.fn().mockResolvedValue({ isActive: false }),
    deleteCommentAutomation: jest.fn().mockResolvedValue(undefined),
  };

  const realtime: any = { emitToWorkspace: jest.fn() };

  const svc = new ZernioService(
    prisma as unknown as PrismaService,
    realtime as unknown as RealtimeService,
    {} as unknown as MediaService,
    client as unknown as ZernioClient,
    { onInboundMessage: jest.fn(), onOutboundReply: jest.fn() } as never,
    { ask: jest.fn().mockResolvedValue(null) } as never,
    { isConfigured: () => false, notifyInbound: jest.fn() } as unknown as AiBridgeService,
  );
  return { svc, prisma, client, realtime };
}

describe("ZernioService — comment auto-reply rules", () => {
  describe("tenancy", () => {
    it("refuses to save a rule for an account this workspace does not own", async () => {
      // The Zernio API key is GLOBAL across workspaces, so this guard is the
      // only thing stopping one tenant arming another tenant's account.
      const { svc, client } = build({ ownChannel: null });
      await expect(
        svc.saveCommentRule(WS, {
          accountId: "someone-elses-account",
          keywords: ["كيوي"],
          dmMessage: "hi?",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(client.createCommentAutomation).not.toHaveBeenCalled();
    });

    it("refuses to enable a rule whose account was disconnected after saving", async () => {
      // Enabling is the moment real DMs start, so ownership is re-checked
      // rather than trusted from save time.
      const { svc, client } = build({ ownChannel: { kind: "instagram", status: "disconnected" } });
      await expect(svc.enableCommentRule(WS, "rule-1")).rejects.toBeInstanceOf(NotFoundException);
      expect(client.createCommentAutomation).not.toHaveBeenCalled();
    });

    it("does not find another workspace's rule", async () => {
      const { svc } = build({ rule: null });
      await expect(svc.enableCommentRule(WS, "rule-1")).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("saving never sends anything", () => {
    it("stores the rule without touching Zernio", async () => {
      const { svc, client } = build({ rule: null });
      const saved = await svc.saveCommentRule(WS, {
        accountId: ACCOUNT,
        keywords: [" كيوي ", "", "kewy"],
        dmMessage: "  أهلاً! شو نوع محلك؟  ",
      });
      expect(client.createCommentAutomation).not.toHaveBeenCalled();
      // Blank keywords dropped, the rest trimmed.
      expect(saved.keywords).toEqual(["كيوي", "kewy"]);
      expect(saved.dmMessage).toBe("أهلاً! شو نوع محلك؟");
      expect(saved.enabled).toBe(false);
    });

    it("rejects a platform with no private reply", async () => {
      // Zernio's matrix: TikTok/Threads/LinkedIn/YouTube can reply publicly
      // but cannot DM a commenter at all, so such a rule could never work.
      const { svc } = build({ ownChannel: { kind: "tiktok", status: "connected" } });
      await expect(
        svc.saveCommentRule(WS, { accountId: ACCOUNT, keywords: ["x"], dmMessage: "hi?" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects an empty keyword list", async () => {
      const { svc } = build({ rule: null });
      await expect(
        svc.saveCommentRule(WS, { accountId: ACCOUNT, keywords: ["  "], dmMessage: "hi?" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("enabling", () => {
    it("creates the automation at Zernio and stores its id", async () => {
      const { svc, prisma, client } = build();
      await svc.enableCommentRule(WS, "rule-1");
      expect(client.createCommentAutomation).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "prof-1",
          accountId: ACCOUNT,
          keywords: ["كيوي"],
          dmMessage: "أهلاً! شو نوع محلك؟",
          repeatPolicy: { mode: "once" },
        }),
      );
      expect(prisma.commentAutoReply.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ automationId: "auto-1", enabled: true }),
        }),
      );
    });

    it("maps reply-every-comment onto Zernio's repeat policy", async () => {
      const { svc, client } = build({
        rule: {
          id: "rule-1",
          workspaceId: WS,
          platform: "instagram",
          accountId: ACCOUNT,
          automationId: null,
          keywords: JSON.stringify(["كيوي"]),
          matchMode: "exact",
          platformPostId: "post-9",
          dmMessage: "hi?",
          commentReply: "بعتنالك عالخاص",
          replyOncePerPerson: false,
          dmDelaySeconds: 8,
          handoffToAgent: true,
          enabled: false,
          enabledAt: null,
          disabledAt: null,
        },
      });
      await svc.enableCommentRule(WS, "rule-1");
      expect(client.createCommentAutomation).toHaveBeenCalledWith(
        expect.objectContaining({
          repeatPolicy: { mode: "every_comment" },
          matchMode: "exact",
          platformPostId: "post-9",
          commentReply: "بعتنالك عالخاص",
          dmDelaySeconds: 8,
        }),
      );
    });

    it("fails loudly if Zernio returns no automation id", async () => {
      // Without an id we could never switch it off again, so a rule that
      // silently recorded itself as enabled would be unstoppable.
      const { svc, prisma, client } = build();
      client.createCommentAutomation.mockResolvedValue({ id: null, isActive: true });
      await expect(svc.enableCommentRule(WS, "rule-1")).rejects.toThrow();
      expect(prisma.commentAutoReply.update).not.toHaveBeenCalled();
    });

    it("does not create a second automation when the rule is already running", async () => {
      const { svc, client } = build({
        rule: {
          id: "rule-1",
          workspaceId: WS,
          platform: "instagram",
          accountId: ACCOUNT,
          automationId: "auto-1",
          keywords: JSON.stringify(["كيوي"]),
          matchMode: "contains",
          platformPostId: null,
          dmMessage: "hi?",
          commentReply: null,
          replyOncePerPerson: true,
          dmDelaySeconds: 0,
          handoffToAgent: true,
          enabled: true,
          enabledAt: new Date(),
          disabledAt: null,
        },
      });
      await svc.enableCommentRule(WS, "rule-1");
      expect(client.createCommentAutomation).not.toHaveBeenCalled();
    });

    it("refuses to enable when Zernio is not connected", async () => {
      const { svc, client } = build({ profileId: null });
      await expect(svc.enableCommentRule(WS, "rule-1")).rejects.toBeInstanceOf(BadRequestException);
      expect(client.createCommentAutomation).not.toHaveBeenCalled();
    });
  });

  const running = {
    id: "rule-1",
    workspaceId: WS,
    platform: "instagram",
    accountId: ACCOUNT,
    automationId: "auto-1",
    keywords: JSON.stringify(["كيوي"]),
    matchMode: "contains",
    platformPostId: null,
    dmMessage: "hi?",
    commentReply: null,
    replyOncePerPerson: true,
    dmDelaySeconds: 0,
    handoffToAgent: true,
    enabled: true,
    enabledAt: new Date(),
    disabledAt: null,
  };

  describe("disabling — the switch that must not lie", () => {
    it("deactivates at Zernio via the undocumented PATCH", async () => {
      const { svc, client, prisma } = build({ rule: running });
      await svc.disableCommentRule(WS, "rule-1");
      expect(client.updateCommentAutomation).toHaveBeenCalledWith("auto-1", { isActive: false });
      expect(client.deleteCommentAutomation).not.toHaveBeenCalled();
      expect(prisma.commentAutoReply.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ enabled: false, automationId: null }),
        }),
      );
    });

    it("falls back to DELETE when PATCH fails", async () => {
      // PATCH is undocumented, so it can disappear without notice. Stopping
      // the DMs matters more than keeping the automation's counters.
      const { svc, client } = build({ rule: running });
      client.updateCommentAutomation.mockRejectedValue(new Error("endpoint_not_found"));
      await svc.disableCommentRule(WS, "rule-1");
      expect(client.deleteCommentAutomation).toHaveBeenCalledWith("auto-1");
    });

    it("does NOT mark the rule off when Zernio could not be stopped at all", async () => {
      // The anti-goal in the design doc: an operator told "paused" while
      // strangers keep receiving DMs.
      const { svc, client, prisma } = build({ rule: running });
      client.updateCommentAutomation.mockRejectedValue(new Error("patch down"));
      client.deleteCommentAutomation.mockRejectedValue(new Error("delete down"));
      await expect(svc.disableCommentRule(WS, "rule-1")).rejects.toThrow();
      expect(prisma.commentAutoReply.update).not.toHaveBeenCalled();
    });

    it("just marks the row off when there is no automation to stop", async () => {
      const { svc, client } = build();
      await svc.disableCommentRule(WS, "rule-1");
      expect(client.updateCommentAutomation).not.toHaveBeenCalled();
      expect(client.deleteCommentAutomation).not.toHaveBeenCalled();
    });

    it("stops the automation before deleting the rule", async () => {
      const { svc, client, prisma } = build({ rule: running });
      await svc.deleteCommentRule(WS, "rule-1");
      expect(client.updateCommentAutomation).toHaveBeenCalled();
      expect(prisma.commentAutoReply.delete).toHaveBeenCalled();
    });
  });

  describe("editing a live rule", () => {
    it("re-creates the automation so the DM people receive is the new one", async () => {
      // Zernio fixes keywords and the message at creation time, so an edit
      // that only touched our row would leave the old DM going out.
      const { svc, client } = build({ rule: running });
      await svc.saveCommentRule(WS, {
        accountId: ACCOUNT,
        keywords: ["kewy"],
        dmMessage: "new message?",
      });
      expect(client.updateCommentAutomation).toHaveBeenCalledWith("auto-1", { isActive: false });
      expect(client.createCommentAutomation).toHaveBeenCalled();
    });
  });

  describe("reading — Zernio is the source of truth", () => {
    it("reports a rule as off when its automation is gone from Zernio", async () => {
      // Someone can switch it off in Zernio's own dashboard; our flag is stale
      // the moment they do.
      const { svc } = build({ rule: running });
      const res = await svc.listCommentRules(WS);
      expect(res.rules[0].enabled).toBe(false);
    });

    it("surfaces Zernio's own counters, and its isActive over ours", async () => {
      const { svc, client } = build({ rule: running });
      client.listCommentAutomations.mockResolvedValue([
        { _id: "auto-1", isActive: true, stats: { dmsSent: 338, dmsFailed: 4 } },
      ]);
      const res = await svc.listCommentRules(WS);
      expect(res.rules[0].enabled).toBe(true);
      expect(res.stats["rule-1"]).toEqual({ dmsSent: 338, dmsFailed: 4 });
    });

    it("still renders the card when Zernio is unreachable", async () => {
      const { svc, client } = build({ rule: running });
      client.listCommentAutomations.mockRejectedValue(new Error("network"));
      const res = await svc.listCommentRules(WS);
      expect(res.stale).toBe(true);
      expect(res.rules).toHaveLength(1);
    });
  });
});
