/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from "@nestjs/common";
import { ZernioRateLimitError } from "../../integrations/zernio.client";
import { CampaignLaunchRunner, MAX_LAUNCH_ATTEMPTS } from "./campaign-launch-runner.service";
import { CAMPAIGN_LAUNCH_STALE_MS } from "./campaign-launch.scheduler";
import {
  channel,
  contact,
  crashOnce,
  deliveryCounts,
  ME,
  withRawInsights,
  world,
  WS,
  zernioCopy,
} from "./launch-test-world";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const H = 3_600_000;
const phone = (i: number) => `+9627900${String(i).padStart(5, "0")}`;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ["nextTick", "setImmediate", "queueMicrotask", "setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
  delete process.env.CAMPAIGN_MAX_PARTITIONS;
  delete process.env.CAMPAIGN_DIRECT_MAX;
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.CAMPAIGN_MAX_PARTITIONS;
  delete process.env.CAMPAIGN_DIRECT_MAX;
});

/** Every phone a Zernio call carried. */
function phonesSeenByZernio(z: any): string[] {
  return [
    ...z.bulkCreateContacts.mock.calls.flatMap((c: any[]) => c[2].map((x: any) => x.platformIdentifier)),
    ...z.addBroadcastRecipients.mock.calls.flatMap((c: any[]) => c[1]),
    ...z.sendTemplateToPhone.mock.calls.map((c: any[]) => c[0].phone),
  ];
}

describe("missing field uses fallback, missing fallback skips recipient with reason", () => {
  const BODY = "Hi {{1}}, your {{2}} service is due on {{3}}";
  const varMap = {
    "1": { source: "field", key: "name" },
    "2": { source: "custom", key: "city", fallback: "your city" },
    "3": { source: "custom", key: "service_due" },
  };
  const defs = [
    { id: "d-city", workspaceId: WS, entity: "contact", key: "city", label: "City", labelAr: "المدينة", type: "text", options: null, archivedAt: null },
    { id: "d-due", workspaceId: WS, entity: "contact", key: "service_due", label: "Service due", labelAr: "موعد الخدمة", type: "date", options: null, archivedAt: null },
    // Another workspace's field with the same key never resolves here.
    { id: "d-foreign", workspaceId: "ws2", entity: "contact", key: "city", label: "X", labelAr: "X", type: "text", options: null, archivedAt: null },
  ];
  const values = [
    { defId: "d-city", contactId: "c1", value: "Amman" },
    { defId: "d-due", contactId: "c1", value: "2026-12-01" },
    { defId: "d-foreign", contactId: "c2", value: "Foreign city" },
    { defId: "d-due", contactId: "c2", value: "2026-12-01" },
    { defId: "d-city", contactId: "c3", value: "Irbid" },
  ];

  it("fills the fallback, skips the contact with no value, never sends to them, and labels the reason", async () => {
    const w = world({
      body: BODY,
      varMap,
      contacts: [contact("c1", "Lina", phone(1)), contact("c2", "Omar", phone(2)), contact("c3", "Sara", phone(3))],
      customFieldDef: defs,
      customFieldValue: values,
    });
    const res = await w.send.launch(WS, "camp", { mode: "now" }, { userId: ME });
    expect(res).toMatchObject({ status: "launching", launchStage: "planning" });
    await w.runner.idle();

    const by = Object.fromEntries(w.rows().map((r: any) => [r.contactId, r]));
    expect(by.c1).toMatchObject({ status: "queued", templateParams: ["Lina", "Amman", "2026-12-01"], channelId: "A" });
    // c2 has no city of THIS workspace: the fallback.
    expect(by.c2).toMatchObject({ status: "queued", templateParams: ["Omar", "your city", "2026-12-01"] });
    expect(by.c3).toMatchObject({ status: "skipped", failureCode: "skip:missing_value:custom.service_due", phone: phone(3), channelId: "A" });
    expect(by.c3.templateParams).toBeNull();
    expect(by.c1.broadcastId).toBeTruthy();
    expect(by.c1.broadcastId).not.toBe(by.c2.broadcastId);

    // No Zernio call carries the skipped contact's phone.
    expect(phonesSeenByZernio(w.zernio)).not.toContain(phone(3));
    expect([...deliveryCounts(w.zernio).keys()].sort()).toEqual([phone(1), phone(2)]);
    expect(w.camp()).toMatchObject({ status: "running", recipients: 2, skipped: 1, launchStage: "done", sendTransport: "broadcast", recipientTracking: true });

    // Two partitions (the city differs); each broadcast carries its literals.
    const created = w.zernio.createWhatsAppBroadcast.mock.calls.map((c: any[]) => c[0].variables);
    expect(created).toEqual(
      expect.arrayContaining([
        [{ field: "name" }, { field: "custom", customValue: "Amman" }, { field: "custom", customValue: "2026-12-01" }],
        [{ field: "name" }, { field: "custom", customValue: "your city" }, { field: "custom", customValue: "2026-12-01" }],
      ]),
    );

    // Insights: a failure line for that code.
    withRawInsights(w.prisma);
    const ins = await w.report.insights(WS, "camp");
    expect(ins.failures).toEqual([{ code: "skip:missing_value:custom.service_due", title: null, count: 1 }]);

    // CSV: labelled in both languages.
    const label = async (lang: "en" | "ar") => {
      const job = await w.report.prepareExport(WS, "camp", { lang, status: "skipped" });
      const out: string[] = [];
      await job.run({ write: (c) => void out.push(c), aborted: () => false });
      return out.join("");
    };
    expect(await label("en")).toContain("No value for Service due");
    expect(await label("ar")).toContain("لا توجد قيمة لـ موعد الخدمة");
  });
});

describe("split sends round-robin across senders", () => {
  it("assigns c1..c7 to A,B,C in id order, the skipped row to the primary, one broadcast per sender", async () => {
    const contacts = [1, 2, 3, 4, 5, 6, 7].map((i) => contact(`c${i}`, `N${i}`, phone(i)));
    contacts.push(contact("c8", "Out", phone(8), { marketingOptOut: true }));
    const w = world({ senders: ["A", "B", "C"], contacts });
    await w.launch();

    const sender = Object.fromEntries(w.rows().map((r: any) => [r.contactId, r.channelId]));
    expect(sender).toEqual({ c1: "A", c2: "B", c3: "C", c4: "A", c5: "B", c6: "C", c7: "A", c8: "A" });
    expect(w.rows().find((r: any) => r.contactId === "c8")).toMatchObject({ status: "skipped", failureCode: "skip:opted_out" });

    // Three broadcasts, each created with its own sender's account, each receiving exactly its own phones.
    const created = w.zernio.createWhatsAppBroadcast.mock.calls.map((c: any[]) => c[0].accountId).sort();
    expect(created).toEqual(["acc-A", "acc-B", "acc-C"]);
    const phonesOf = (acc: string) => {
      const ids = [...w.zernio.broadcasts.values()].filter((b: any) => b.accountId === acc).map((b: any) => b.id);
      return w.zernio.addBroadcastRecipients.mock.calls.filter((c: any[]) => ids.includes(c[0])).flatMap((c: any[]) => c[1]).sort();
    };
    expect(phonesOf("acc-A")).toEqual([phone(1), phone(4), phone(7)]);
    expect(phonesOf("acc-B")).toEqual([phone(2), phone(5)]);
    expect(phonesOf("acc-C")).toEqual([phone(3), phone(6)]);
    expect(w.partitions().map((p: any) => [p.channelId, p.recipientCount]).sort()).toEqual([
      ["A", 3],
      ["B", 2],
      ["C", 2],
    ]);

    // byNumber: 3/2/2 reachable (A also holds the skipped row).
    withRawInsights(w.prisma);
    const ins = await w.report.insights(WS, "camp");
    expect(ins.byNumber.map((b) => [b.channelId, b.total - b.skipped, b.skipped])).toEqual([
      ["A", 3, 1],
      ["B", 2, 0],
      ["C", 2, 0],
    ]);

    // The preview's split for the same draft equals it.
    const pv = await w.preview.preview(WS, { senderChannelIds: ["A", "B", "C"], templateId: "tpl" }, { canViewContacts: false });
    expect(pv.split.map((s) => [s.channelId, s.recipients])).toEqual([
      ["A", 3],
      ["B", 2],
      ["C", 2],
    ]);
  });
});

describe("launch job resumes after crash without double send", () => {
  const six = () => [1, 2, 3, 4, 5, 6].map((i) => contact(`c${i}`, `N${i}`, phone(i)));
  const cityDefs = [{ id: "d-city", workspaceId: WS, entity: "contact", key: "city", label: "City", labelAr: "المدينة", type: "text", options: null, archivedAt: null }];
  const cityValues = [1, 2, 3, 4, 5, 6].map((i) => ({ defId: "d-city", contactId: `c${i}`, value: i % 2 ? "Amman" : "Irbid" }));

  type Case = {
    name: string;
    direct?: boolean;
    inject: (w: ReturnType<typeof world>) => void;
    check?: (w: ReturnType<typeof world>) => void;
    beforeResume?: (w: ReturnType<typeof world>) => void;
  };

  const cases: Case[] = [
    {
      name: "(a) during plan, after half the pages: rows are rebuilt with no duplicates",
      inject: (w) => crashOnce(w.prisma.contact, "findMany", (_a, n) => n === 2),
      check: (w) => {
        expect(w.rows()).toHaveLength(6);
        expect(new Set(w.rows().map((r: any) => r.phone)).size).toBe(6);
        expect(w.partitions()).toHaveLength(1);
      },
    },
    {
      name: "(b) after bulkCreateContacts, before stage = contacts_imported",
      inject: (w) => crashOnce(w.prisma.campaignBroadcast, "update", (a) => a.data?.stage === "contacts_imported"),
      check: (w) => expect(w.zernio.createWhatsAppBroadcast).toHaveBeenCalledTimes(1),
    },
    {
      name: "(c) after createWhatsAppBroadcast returned, before zernioBroadcastId is stored: the draft is adopted by its marker",
      inject: (w) => crashOnce(w.prisma.campaignBroadcast, "update", (a) => !!a.data?.zernioBroadcastId),
      check: (w) => {
        expect(w.zernio.createWhatsAppBroadcast).toHaveBeenCalledTimes(1);
        expect(w.zernio.listBroadcasts).toHaveBeenCalledWith({ profileId: "prof1", status: "draft", limit: 100 });
        const p = w.partitions()[0];
        expect(w.zernio.createWhatsAppBroadcast.mock.calls[0][0].name).toBe(`Service reminder · crm:${p.id}`);
        expect(p.zernioBroadcastId).toBe("zb1");
      },
    },
    {
      name: "(d) after addBroadcastRecipients for 2 of 3 pages: re-adding is deduped",
      inject: (w) => crashOnce(w.prisma.campaignBroadcast, "update", (a, _n) => a.data?.addedThroughId !== undefined && w.zernio.addBroadcastRecipients.mock.calls.length === 2),
      check: (w) => {
        const b = [...w.zernio.broadcasts.values()][0];
        expect(b.recipients.size).toBe(6);
        // Page 2 was added again after the crash; Zernio counted those as skipped.
        expect(w.zernio.addBroadcastRecipients).toHaveBeenCalledTimes(4);
      },
    },
    {
      name: "(e) after sendBroadcast succeeded, before stage = sent: the status check prevents a second send",
      inject: (w) => crashOnce(w.prisma.campaignBroadcast, "update", (a) => a.data?.stage === "sent"),
      check: (w) => {
        expect(w.zernio.sendBroadcast).toHaveBeenCalledTimes(1);
        // The resume read GET /broadcasts/{id} and found it sending.
        expect(w.zernio.getBroadcast).toHaveBeenCalledTimes(2);
        expect(w.partitions()[0].stage).toBe("sent");
      },
    },
    {
      name: "(f) direct: after sendTemplateToPhone, before messageId is stored: re-sent with the same Idempotency-Key",
      direct: true,
      inject: (w) => crashOnce(w.prisma.campaignRecipient, "updateMany", (a) => !!a.data?.messageId),
      check: (w) => {
        const keys = w.zernio.sendTemplateToPhone.mock.calls.map((c: any[]) => c[0].idempotencyKey);
        // One key was used twice (the replayed send); every other once.
        expect(keys).toHaveLength(7);
        expect(new Set(keys).size).toBe(6);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[0]).toMatch(/^crm-cr-/);
        expect(w.rows().every((r: any) => r.status === "sent" && r.messageId)).toBe(true);
      },
    },
    {
      name: "(g) direct: an attempt older than 23 h is marked failed launch:unconfirmed and not re-sent",
      direct: true,
      inject: (w) => crashOnce(w.prisma.campaignRecipient, "updateMany", (a) => !!a.data?.messageId),
      beforeResume: () => jest.setSystemTime(new Date(NOW.getTime() + 24 * H)),
      check: (w) => {
        const keys = w.zernio.sendTemplateToPhone.mock.calls.map((c: any[]) => c[0].idempotencyKey);
        expect(keys).toHaveLength(6);
        const unconfirmed = w.rows().filter((r: any) => r.status === "failed");
        expect(unconfirmed).toHaveLength(1);
        expect(unconfirmed[0]).toMatchObject({ failureCode: "launch:unconfirmed", messageId: null });
        expect(`crm-cr-${unconfirmed[0].id}`).toBe(keys[0]);
      },
    },
  ];

  it.each(cases.map((c) => [c.name, c]))("%s", async (_name, c) => {
    if (c.direct) process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world(
      c.direct
        ? { contacts: six(), body: "Hi {{1}}", varMap: { "1": { source: "custom", key: "city" } }, customFieldDef: cityDefs, customFieldValue: cityValues }
        : { contacts: six() },
    );
    w.runner.pageSize = 2;
    w.runner.addPageSize = 2;
    c.inject(w);
    await w.launch();
    // The "crash" left the job launching (a transient failure).
    expect(w.camp().status).toBe("launching");
    c.beforeResume?.(w);
    expect(await w.resume()).toBe(1);

    const counts = deliveryCounts(w.zernio);
    expect([...counts.keys()].sort()).toEqual(six().map((x) => x.phone).sort());
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(["running", "scheduled"]).toContain(w.camp().status);
    expect(w.camp().sendTransport).toBe(c.direct ? "direct" : "broadcast");
    c.check?.(w);
  });
});

describe("launch concurrency, leases and cancel", () => {
  const contacts = (n: number) => Array.from({ length: n }, (_, i) => contact(`c${String(i).padStart(3, "0")}`, `N${i}`, phone(i)));

  it("concurrent launch requests start one job", async () => {
    const w = world({ contacts: contacts(3) });
    const run = jest.spyOn(w.runner, "run");
    const results = await Promise.allSettled([
      w.send.launch(WS, "camp", { mode: "now" }, { userId: ME }),
      w.send.launch(WS, "camp", { mode: "now" }, { userId: ME }),
    ]);
    await w.runner.idle();
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.getStatus()).toBe(409);
    expect(rejected.reason.getResponse()).toMatchObject({ message: "campaigns.already_launched" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(w.zernio.sendBroadcast).toHaveBeenCalledTimes(1);
  });

  it("a stale runner stops after its lease is taken", async () => {
    const w = world({ contacts: contacts(6) });
    const r1 = w.runner;
    r1.addPageSize = 2;
    // Runner 1 pauses inside its first addBroadcastRecipients call.
    let release!: () => void;
    const paused = new Promise<void>((r) => (release = r));
    const realAdd = w.zernio.addBroadcastRecipients.getMockImplementation()!;
    let first = true;
    w.zernio.addBroadcastRecipients.mockImplementation(async (id: string, phones: string[]) => {
      const res = await realAdd(id, phones);
      if (first) {
        first = false;
        await paused;
      }
      return res;
    });
    await w.send.launch(WS, "camp", { mode: "now" }, { userId: ME });
    // Let runner 1 reach the paused call.
    for (let i = 0; i < 50 && first; i++) await new Promise((r) => setImmediate(r));
    expect(first).toBe(false);

    // Another machine's scheduler takes the stale lease and finishes the job.
    const r2 = w.makeRunner();
    r2.addPageSize = 2;
    const { CampaignLaunchScheduler } = await import("./campaign-launch.scheduler");
    const s2 = new CampaignLaunchScheduler(w.prisma, r2, w.tracker);
    expect(await s2.sweep(new Date(Date.now() + 3 * 60_000))).toBe(1);
    await r2.idle();
    expect(w.camp().status).toBe("running");
    const calls = () =>
      ["bulkCreateContacts", "createWhatsAppBroadcast", "addBroadcastRecipients", "getBroadcast", "sendBroadcast", "listBroadcasts"].reduce(
        (n, k) => n + (w.zernio as any)[k].mock.calls.length,
        0,
      );
    const before = calls();
    const beforeRow = JSON.stringify(w.partitions());

    // Runner 1 wakes up: its next compare-and-set matches nothing; it calls Zernio no more and writes nothing.
    release();
    await r1.idle();
    expect(calls()).toBe(before);
    expect(JSON.stringify(w.partitions())).toBe(beforeRow);
    expect(w.zernio.sendBroadcast).toHaveBeenCalledTimes(1);
    expect([...deliveryCounts(w.zernio).values()].every((n) => n === 1)).toBe(true);
  });

  it("cancel during launch sends nothing further", async () => {
    const w = world({ senders: ["A", "B"], contacts: contacts(4) });
    const realSend = w.zernio.sendBroadcast.getMockImplementation()!;
    w.zernio.sendBroadcast.mockImplementation(async (id: string) => {
      await realSend(id);
      // The user cancels right after partition 1 went out.
      const res = await w.send.cancel(WS, "camp");
      expect(res.status).toBe("launching");
      expect(res.cancelRequestedAt).toBeTruthy();
    });
    await w.launch();
    expect(w.zernio.sendBroadcast).toHaveBeenCalledTimes(1);
    const [sentId] = w.zernio.sendBroadcast.mock.calls[0];
    expect(w.zernio.cancelBroadcast).toHaveBeenCalledWith(sentId);
    // Partition 2's draft is deleted in Zernio.
    expect(w.zernio.deleteBroadcast).toHaveBeenCalledTimes(1);
    expect(w.zernio.deleteBroadcast.mock.calls[0][0]).not.toBe(sentId);
    expect(w.zernio.broadcasts.size).toBe(1);
    expect(w.partitions().map((p: any) => p.stage)).toEqual(["cancelled", "cancelled"]);
    expect(w.camp()).toMatchObject({ status: "cancelled", launchStage: "done" });
    // The cancelled partition's rows stay queued ("Not sent").
    expect(w.rows().every((r: any) => r.status === "queued")).toBe(true);
  });

  it("cancel while planning cancels without any Zernio call", async () => {
    const w = world({ contacts: contacts(3) });
    await w.send.launch(WS, "camp", { mode: "now" }, { userId: ME });
    await w.send.cancel(WS, "camp");
    await w.runner.idle();
    expect(w.camp().status).toBe("cancelled");
    expect(w.zernio.createWhatsAppBroadcast).not.toHaveBeenCalled();
    expect(w.zernio.deliveries).toEqual([]);
  });

  it("every Zernio call is behind a fresh lease compare-and-set and a budget token", async () => {
    const w = world({ senders: ["A", "B"], contacts: contacts(5) });
    w.runner.addPageSize = 2;
    const beats: number[] = [];
    for (const k of ["bulkCreateContacts", "createWhatsAppBroadcast", "addBroadcastRecipients", "getBroadcast", "sendBroadcast"]) {
      const fn = (w.zernio as any)[k];
      const impl = fn.getMockImplementation();
      fn.mockImplementation(async (...args: any[]) => {
        beats.push(w.camp().launchHeartbeatAt.getTime());
        return impl(...args);
      });
    }
    await w.launch();
    expect(beats.length).toBeGreaterThan(8);
    for (let i = 1; i < beats.length; i++) expect(beats[i]).toBeGreaterThan(beats[i - 1]);
    expect(w.takes.campaign).toBe(beats.length);
    expect(w.takes.direct).toBe(0);
  });
});

describe("partitions never mix resolved values", () => {
  const defs = [{ id: "d-city", workspaceId: WS, entity: "contact", key: "city", label: "City", labelAr: "المدينة", type: "text", options: null, archivedAt: null }];
  const gen = (n: number, distinct: number) => {
    const contacts = Array.from({ length: n }, (_, i) => contact(`k${String(i).padStart(5, "0")}`, `N${i}`, `+9627${String(i).padStart(8, "0")}`));
    const values = contacts.map((c, i) => ({ defId: "d-city", contactId: c.id, value: `City ${i % distinct}` }));
    return { contacts, values };
  };
  const varMap = { "1": { source: "field", key: "name" }, "2": { source: "custom", key: "city" } };

  it("2 000 contacts, 3 senders, 4 cities: 12 broadcast partitions, each row equal to its partition's literals", async () => {
    const { contacts, values } = gen(2000, 4);
    const w = world({ senders: ["A", "B", "C"], body: "Hi {{1}} from {{2}}", varMap, contacts, customFieldDef: defs, customFieldValue: values });
    await w.launch();
    const parts = w.partitions();
    expect(parts).toHaveLength(12);
    expect(w.camp().sendTransport).toBe("broadcast");
    const byId = new Map(parts.map((p: any) => [p.id, p]));
    for (const r of w.rows()) {
      const p: any = byId.get(r.broadcastId);
      expect(p.channelId).toBe(r.channelId);
      expect(p.variables["1"]).toEqual({ field: "name" });
      expect(p.variables["2"]).toEqual({ field: "custom", customValue: r.templateParams[1] });
    }
    expect(parts.reduce((n: number, p: any) => n + p.recipientCount, 0)).toBe(2000);
    expect([...deliveryCounts(w.zernio).values()].every((n) => n === 1)).toBe(true);
    expect(deliveryCounts(w.zernio).size).toBe(2000);
  });

  it("40 cities: 120 partitions > 25 → direct sends (≤ 5 000), one per recipient with its own values", async () => {
    const { contacts, values } = gen(240, 40);
    const w = world({ senders: ["A", "B", "C"], body: "Hi {{1}} from {{2}}", varMap, contacts, customFieldDef: defs, customFieldValue: values });
    await w.launch();
    expect(w.camp()).toMatchObject({ sendTransport: "direct", status: "running" });
    // One direct batch per sender; rows keep their sender.
    expect(w.partitions().map((p: any) => [p.channelId, p.transport, p.recipientCount]).sort()).toEqual([
      ["A", "direct", 80],
      ["B", "direct", 80],
      ["C", "direct", 80],
    ]);
    expect(w.zernio.createWhatsAppBroadcast).not.toHaveBeenCalled();
    expect(w.zernio.sendTemplateToPhone).toHaveBeenCalledTimes(240);
    const rowByPhone = new Map(w.rows().map((r: any) => [r.phone, r]));
    for (const [input] of w.zernio.sendTemplateToPhone.mock.calls as any[]) {
      const r: any = rowByPhone.get(input.phone);
      expect(input.templateParams).toEqual(r.templateParams);
      expect(input.accountId).toBe(`acc-${r.channelId}`);
      expect(input.idempotencyKey).toBe(`crm-cr-${r.id}`);
    }
    expect(w.takes.direct).toBe(240);
  });

  it("6 000 reachable over both caps → too_varied failure, no Zernio send", async () => {
    const { contacts, values } = gen(6000, 40);
    const w = world({ senders: ["A", "B", "C"], body: "Hi {{1}} from {{2}}", varMap, contacts, customFieldDef: defs, customFieldValue: values });
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "failed", launchStage: "failed", lastError: "campaigns.var_map_too_varied" });
    for (const k of ["bulkCreateContacts", "createWhatsAppBroadcast", "addBroadcastRecipients", "sendBroadcast", "sendTemplateToPhone"]) {
      expect((w.zernio as any)[k]).not.toHaveBeenCalled();
    }
    expect(w.notifications.notify).toHaveBeenCalledWith(WS, [ME], expect.objectContaining({ type: "campaign_finished", title: "campaign.launch_failed" }));
  });
});

describe("launch of 100k plans in pages and never inserts more than 1000 rows per call", () => {
  it("streams 100 audience pages, writes ≤1000 rows per createMany, yields between pages; the HTTP launch returns first", async () => {
    const w = world({ contacts: [] });
    // A mocked 100 000-member audience, generated page by page (never held at once).
    const N = 100_000;
    const audiencePages: number[] = [];
    w.prisma.contact.findMany = jest.fn(async (a: any) => {
      const from = a.where?.id?.gt ? Number(String(a.where.id.gt).slice(1)) + 1 : 0;
      const n = Math.max(0, Math.min(a.take, N - from));
      audiencePages.push(n);
      return Array.from({ length: n }, (_, k) => {
        const i = from + k;
        return { id: `k${String(i).padStart(6, "0")}`, name: `N${i}`, firstName: null, lastName: null, phone: `+9627${String(i).padStart(8, "0")}`, email: null, lifecycle: "lead", marketingOptOut: i % 50 === 0 };
      });
    });
    const sizes: number[] = [];
    w.prisma.campaignRecipient.createMany = jest.fn(async (a: any) => {
      sizes.push(a.data.length);
      return { count: a.data.length };
    });
    const ticks = jest.spyOn(w.runner as any, "yieldTick");

    const res = await w.send.launch(WS, "camp", { mode: "now" }, { userId: ME });
    // The HTTP call resolved before planning started.
    expect(res.status).toBe("launching");
    expect(audiencePages).toEqual([]);
    await w.runner.idle();

    expect(audiencePages.filter((n) => n > 0)).toHaveLength(100);
    expect(Math.max(...sizes)).toBe(1000);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(N);
    expect(ticks.mock.calls.length).toBeGreaterThanOrEqual(100);
    expect(w.camp()).toMatchObject({ recipients: 98_000, skipped: 2_000 });
  });
});

describe("transient errors keep the job launching; permanent errors fail it and notify the launcher", () => {
  const contacts = [contact("c1", "A", phone(1)), contact("c2", "B", phone(2))];

  it("a 502 keeps it launching up to MAX_LAUNCH_ATTEMPTS, then fails with a keyed error and a notification", async () => {
    const w = world({ contacts });
    w.zernio.bulkCreateContacts.mockRejectedValue(new HttpException("Zernio down", 502));
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "launching", launchAttempts: 1 });
    expect(w.notifications.notify).not.toHaveBeenCalled();
    for (let i = 2; i < MAX_LAUNCH_ATTEMPTS; i++) {
      jest.setSystemTime(new Date(Date.now() + 3 * 60_000));
      await w.resume();
      expect(w.camp()).toMatchObject({ status: "launching", launchAttempts: i });
    }
    jest.setSystemTime(new Date(Date.now() + 3 * 60_000));
    await w.resume();
    expect(w.camp()).toMatchObject({ status: "failed", launchStage: "failed", lastError: "campaigns.launch_failed", launchAttempts: MAX_LAUNCH_ATTEMPTS });
    expect(w.partitions()[0].lastError).toBe("Zernio down");
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
    expect(w.notifications.notify).toHaveBeenCalledWith(WS, [ME], {
      type: "campaign_finished",
      title: "campaign.launch_failed",
      body: JSON.stringify({ name: "Service reminder", error: "campaigns.launch_failed" }),
      recordKind: "campaign",
      recordId: "camp",
    });
    // Rows stay queued: nothing was sent.
    expect(w.rows().every((r: any) => r.status === "queued")).toBe(true);
    expect(w.zernio.deliveries).toEqual([]);
  });

  it("a 429 waits for Retry-After and keeps the lease (no attempt used)", async () => {
    const w = world({ contacts });
    const sleep = jest.fn(async () => {});
    w.runner.sleep = sleep;
    w.zernio.createWhatsAppBroadcast.mockRejectedValueOnce(new ZernioRateLimitError("slow", 2000));
    await w.launch();
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(w.camp()).toMatchObject({ status: "running", launchAttempts: 0 });
    expect(w.zernio.createWhatsAppBroadcast).toHaveBeenCalledTimes(2);
  });

  it("a permanent error fails at once", async () => {
    const w = world({ contacts });
    w.zernio.createWhatsAppBroadcast.mockRejectedValue(new HttpException("Template parameter count mismatch", 400));
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "failed", lastError: "campaigns.launch_failed", launchAttempts: 1 });
    expect(w.partitions()[0].lastError).toBe("Template parameter count mismatch");
    expect(w.notifications.notify).toHaveBeenCalledTimes(1);
  });

  it("an empty audience fails with campaigns.no_reachable_recipients", async () => {
    const w = world({ contacts: [contact("c1", "X", null)] });
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "failed", lastError: "campaigns.no_reachable_recipients" });
    expect(w.zernio.bulkCreateContacts).not.toHaveBeenCalled();
  });

  it("a stale launch is only resumed once its heartbeat is older than CAMPAIGN_LAUNCH_STALE_MS", async () => {
    const w = world({ contacts });
    w.zernio.bulkCreateContacts.mockRejectedValueOnce(new HttpException("Zernio down", 503));
    await w.launch();
    expect(await w.scheduler.sweep(new Date(Date.now() + CAMPAIGN_LAUNCH_STALE_MS - 1000))).toBe(0);
    expect(await w.resume(CAMPAIGN_LAUNCH_STALE_MS + 1000)).toBe(1);
    expect(w.camp().status).toBe("running");
  });
});

describe("scheduled direct campaign starts at scheduledAt", () => {
  it("waits as scheduled, and the scheduler starts it when due", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({
      senders: ["A", "B"],
      contacts: [contact("c1", "A", phone(1)), contact("c2", "B", phone(2)), contact("c3", "C", phone(3))],
    });
    const at = new Date(NOW.getTime() + H);
    await w.launch({ mode: "schedule", scheduledAt: at.toISOString() });
    expect(w.camp()).toMatchObject({ status: "scheduled", sendTransport: "direct", launchStage: "sending" });
    expect(w.camp().scheduledAt).toEqual(at);
    expect(w.zernio.sendTemplateToPhone).not.toHaveBeenCalled();

    expect(await w.scheduler.sweep(new Date(NOW.getTime() + 30 * 60_000))).toBe(0);
    await w.runner.idle();
    expect(w.zernio.sendTemplateToPhone).not.toHaveBeenCalled();

    jest.setSystemTime(new Date(at.getTime() + 60_000));
    expect(await w.scheduler.sweep(new Date())).toBe(1);
    await w.runner.idle();
    expect(w.zernio.sendTemplateToPhone).toHaveBeenCalledTimes(3);
    expect(w.camp()).toMatchObject({ status: "running", launchStage: "done" });
  });

  it("a scheduled direct campaign can be cancelled while it waits", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({ senders: ["A", "B"], contacts: [contact("c1", "A", phone(1)), contact("c2", "B", phone(2))] });
    await w.launch({ mode: "schedule", scheduledAt: new Date(NOW.getTime() + H).toISOString() });
    expect((await w.send.cancel(WS, "camp")).status).toBe("cancelled");
    jest.setSystemTime(new Date(NOW.getTime() + 2 * H));
    expect(await w.scheduler.sweep(new Date())).toBe(0);
    expect(w.zernio.sendTemplateToPhone).not.toHaveBeenCalled();
  });
});

describe("direct campaign completes when no queued rows remain, and counters recount from rows", () => {
  it("recountDirect recounts and completes a running direct campaign", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({ senders: ["A", "B"], contacts: [contact("c1", "A", phone(1)), contact("c2", "B", phone(2)), contact("c3", "C", phone(3))] });
    await w.launch();
    expect(w.camp()).toMatchObject({ status: "running", sendTransport: "direct", sent: 3 });
    // A webhook marks one delivered, another read.
    const [r1, r2] = w.rows();
    r1.status = "delivered";
    r2.status = "read";
    await w.scheduler.recountDirect(new Date());
    expect(w.camp()).toMatchObject({ status: "completed", sent: 3, delivered: 2, read: 1 });
  });

  it("a direct campaign with queued rows left stays running", async () => {
    process.env.CAMPAIGN_MAX_PARTITIONS = "1";
    const w = world({ senders: ["A", "B"], contacts: [contact("c1", "A", phone(1)), contact("c2", "B", phone(2))] });
    await w.launch();
    w.rows()[0].status = "queued";
    await w.scheduler.recountDirect(new Date());
    expect(w.camp().status).toBe("running");
  });
});

describe("header override is passed as headerMedia on direct sends (R8 forces direct; no broadcast header), with a TTL per ruling 9", () => {
  const img = { id: "m1", workspaceId: WS, mimeType: "image/png", sizeBytes: 1000, uploadedById: "u1" };

  it("forces direct transport and sends headerMedia {link} with a 72 h link", async () => {
    const w = world({
      contacts: [contact("c1", "A", phone(1)), contact("c2", "B", phone(2))],
      campaign: { headerMediaId: "m1" },
      template: { headerType: "image" },
      media: [img],
    });
    await w.launch();
    expect(w.camp()).toMatchObject({ sendTransport: "direct", status: "running" });
    expect(w.zernio.createWhatsAppBroadcast).not.toHaveBeenCalled();
    expect(w.media.resolveExternalUrl).toHaveBeenCalledWith(WS, "m1", 72 * 3600);
    for (const [input] of w.zernio.sendTemplateToPhone.mock.calls as any[]) {
      expect(input.headerMedia).toEqual({ link: `https://cdn.test/m1?ttl=${72 * 3600}` });
    }
    // The launch check read the file as the launcher.
    expect(w.media.get).toHaveBeenCalledWith(WS, "m1", { userId: ME });
  });

  it("the link TTL covers the wait until scheduledAt, at most 7 days", async () => {
    const w = world({ campaign: { headerMediaId: "m1" }, template: { headerType: "image" }, media: [img] });
    const runner: any = w.runner;
    expect(runner.headerTtlSeconds(null)).toBe(72 * 3600);
    expect(runner.headerTtlSeconds(new Date(NOW.getTime() + 24 * H))).toBe(96 * 3600);
    expect(runner.headerTtlSeconds(new Date(NOW.getTime() + 6 * 24 * H))).toBe(7 * 24 * 3600);
  });

  it("refuses a mismatched kind, an oversized file and a schedule more than 6 days ahead", async () => {
    const err = async (w: ReturnType<typeof world>, input: any = { mode: "now" }) => {
      try {
        await w.send.launch(WS, "camp", input, { userId: ME });
      } catch (e) {
        return { status: (e as HttpException).getStatus(), body: (e as HttpException).getResponse() };
      }
      return null;
    };
    const mismatch = world({ campaign: { headerMediaId: "m1" }, template: { headerType: "video" }, media: [img] });
    expect(await err(mismatch)).toMatchObject({ status: 400, body: { message: "templates.header_media_mismatch" } });
    const big = world({ campaign: { headerMediaId: "m1" }, template: { headerType: "image" }, media: [{ ...img, sizeBytes: 6 * 1024 * 1024 }] });
    expect(await err(big)).toMatchObject({ status: 400, body: { message: "templates.header_media_too_large", limit: 5 * 1024 * 1024 } });
    const far = world({ campaign: { headerMediaId: "m1" }, template: { headerType: "image" }, media: [img] });
    expect(await err(far, { mode: "schedule", scheduledAt: new Date(NOW.getTime() + 7 * 24 * H).toISOString() })).toMatchObject({
      status: 400,
      body: { message: "campaigns.header_media_schedule_too_far", days: 6 },
    });
    const foreign = world({ campaign: { headerMediaId: "m-x" }, template: { headerType: "image" }, media: [{ ...img, id: "m-x", workspaceId: "ws2" }] });
    expect(await err(foreign)).toMatchObject({ status: 404 });
    for (const w of [mismatch, big, far, foreign]) expect(w.camp().status).toBe("draft");
  });
});

describe("runner basics", () => {
  it("run() ignores a campaign that is not launching", async () => {
    const w = world({ contacts: [contact("c1", "A", phone(1))] });
    await w.runner.run("camp");
    await w.runner.run("missing");
    expect(w.camp().status).toBe("draft");
    expect(w.zernio.bulkCreateContacts).not.toHaveBeenCalled();
  });

  it("GET-style launch progress: stage, planned rows, partitions done, direct sent", async () => {
    const w = world({ senders: ["A", "B"], contacts: [contact("c1", "A", phone(1)), contact("c2", "B", phone(2)), contact("c3", "C", null)] });
    await w.launch();
    const p = await CampaignLaunchRunner.progress(w.prisma, WS, w.camp());
    expect(p).toEqual({ stage: "done", planned: 3, partitionsTotal: 2, partitionsDone: 2, directSent: 0 });
  });
});

void channel;
void zernioCopy;
