/* eslint-disable @typescript-eslint/no-explicit-any */
import { A, bookingInput, failure, lifecycleWorld } from "./lifecycle-test-world";
import { LIFECYCLE_CATALOG } from "./lifecycle-catalog";

const sysWf = (w: ReturnType<typeof lifecycleWorld>, key: string) => w.db.workflow.find((x) => x.systemKey === `lifecycle.${key}`);

async function enabled(w: ReturnType<typeof lifecycleWorld>, key: string) {
  await w.lifecycle.setup(A, key);
  w.approveAll();
  return w.lifecycle.patch(A, key, { enabled: true });
}

describe("lifecycle setup", () => {
  it("setup is idempotent and creates nothing on a provider twice", async () => {
    const w = lifecycleWorld();
    const row = await w.lifecycle.setup(A, "booking_confirmed");
    expect(w.templates.created.map((t) => [t.name, t.category, t.footer, t.lang])).toEqual([
      ["kewy_booking_confirmed_ar", "UTILITY", "Acme Salon", "ar"],
      ["kewy_booking_confirmed_en", "UTILITY", "Acme Salon", "en"],
    ]);
    expect(w.templates.created[0].body).toBe(LIFECYCLE_CATALOG.booking_confirmed.bodies!.ar);
    expect(w.templates.created[1].bodyExamples).toHaveLength(4);
    expect(row).toMatchObject({ key: "booking_confirmed", setUp: true, enabled: false, recipient: { kind: "customer" } });
    expect(row.variants?.ar).toMatchObject({ name: "kewy_booking_confirmed_ar", status: "pending" });
    expect(sysWf(w, "booking_confirmed")).toMatchObject({ status: "draft", triggerType: "appointment_confirmed" });

    // A second call creates nothing.
    const again = await w.lifecycle.setup(A, "booking_confirmed");
    expect(w.templates.create).toHaveBeenCalledTimes(2);
    expect(w.db.workflow).toHaveLength(1);
    expect(again.workflowId).toBe(row.workflowId);

    // An existing same-name template is reused unchanged.
    w.db.template.push({ id: "tExisting", workspaceId: A, name: "kewy_booking_cancelled_ar", lang: "ar", category: "UTILITY", status: "approved", body: "custom", footer: null, metaRejectionReason: null, quality: null });
    await w.lifecycle.setup(A, "booking_cancelled");
    expect(w.templates.created.map((t) => t.name).slice(2)).toEqual(["kewy_booking_cancelled_en"]);
    expect(w.db.template.find((t) => t.id === "tExisting")).toMatchObject({ body: "custom", status: "approved" });

    // Staff keys create only the workflow.
    const staff = await w.lifecycle.setup(A, "ticket_opened_staff");
    expect(w.templates.create).toHaveBeenCalledTimes(3);
    expect(staff).toMatchObject({ audience: "staff", variants: null, recipient: { kind: "permitted", userIds: [] } });
    expect(sysWf(w, "ticket_opened_staff").steps.steps.notify).toMatchObject({ type: "notify_staff", config: { recipient: "permitted", messageKey: "lifecycle.ticket_opened" } });
  });

  it("no WhatsApp: 409 and nothing is created", async () => {
    const w = lifecycleWorld({ withWhatsapp: false });
    expect(await failure(w.lifecycle.setup(A, "booking_confirmed"))).toEqual({
      status: 409,
      body: { statusCode: 409, message: "lifecycle.whatsapp_not_connected" },
    });
    expect(w.templates.create).not.toHaveBeenCalled();
    expect(w.db.workflow).toHaveLength(0);
    expect((await w.lifecycle.list(A)).whatsappConnected).toBe(false);
    expect(await failure(w.lifecycle.sync(A))).toMatchObject({ status: 409 });
  });

  it("unknown key is 404, list reads every key in order", async () => {
    const w = lifecycleWorld();
    expect(await failure(w.lifecycle.setup(A, "nope"))).toMatchObject({ status: 404, body: { message: "lifecycle.unknown_key" } });
    expect(await failure(w.lifecycle.patch(A, "nope", {}))).toMatchObject({ status: 404 });
    const list = await w.lifecycle.list(A);
    expect(list.rows.map((r) => r.key)).toEqual(Object.keys(LIFECYCLE_CATALOG));
    expect(list.rows.every((r) => !r.setUp && !r.enabled)).toBe(true);
    expect(list.rows.find((r) => r.key === "booking_reminder")?.offsetMinutes).toBe(1440);
    expect(list.rows.find((r) => r.key === "booking_confirmed")?.blockedReason).toBe("template_missing");
    expect(await failure(w.lifecycle.patch(A, "booking_confirmed", { enabled: true }))).toMatchObject({ status: 409, body: { message: "lifecycle.not_set_up" } });
  });
});

describe("enable gate and toggle", () => {
  it("toggling off disables the system workflow", async () => {
    const w = lifecycleWorld();
    const on = await enabled(w, "booking_confirmed");
    expect(on.enabled).toBe(true);
    expect(sysWf(w, "booking_confirmed").status).toBe("active");

    await w.bookings.create(A, bookingInput());
    await w.flush();
    expect(w.zernio.sends).toHaveLength(1);

    const off = await w.lifecycle.patch(A, "booking_confirmed", { enabled: false });
    expect(sysWf(w, "booking_confirmed").status).toBe("draft");
    expect(off.enabled).toBe(false);
    const runsBefore = w.runs().length;
    await w.bookings.create(A, bookingInput({ startAt: "2027-01-06T07:30:00.000Z" }));
    await w.flush();
    expect(w.runs()).toHaveLength(runsBefore);
    expect(w.zernio.sends).toHaveLength(1);

    // A run parked by the payment lock is cancelled by the toggle.
    await w.lifecycle.patch(A, "booking_confirmed", { enabled: true });
    w.paymentLock.isLocked.mockResolvedValueOnce(false).mockResolvedValueOnce(true); // dispatch ok, then locked at send
    await w.bookings.create(A, bookingInput({ startAt: "2027-01-07T07:30:00.000Z" }));
    await w.flush();
    const parked = w.runs().find((r) => r.status === "waiting");
    expect(parked).toBeDefined();
    await w.lifecycle.patch(A, "booking_confirmed", { enabled: false });
    expect(w.runs().find((r) => r.id === parked.id).status).toBe("cancelled");
    expect(w.zernio.sends).toHaveLength(1);
    expect((await w.lifecycle.getRow(A, "booking_confirmed")).enabled).toBe(false);
  });

  it("payment lock parks a lifecycle run; toggle off cancels parked runs", async () => {
    const w = lifecycleWorld();
    await enabled(w, "booking_cancelled");
    w.locked.value = false;
    w.paymentLock.isLocked.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const appt = await w.bookings.create(A, bookingInput({ status: "confirmed" }));
    await w.flush();
    await w.bookings.update(A, (appt as any).id, { status: "cancelled" } as any);
    await w.flush();
    // The second dispatch (cancelled) parks at the send step.
    w.paymentLock.isLocked.mockReset().mockResolvedValue(false);
    const cancelledRuns = w.runs().filter((r) => r.workflowId === sysWf(w, "booking_cancelled").id);
    expect(cancelledRuns.length).toBe(1);
    // A run parked by the lock (simulated directly) is cancelled on toggle off.
    w.db.workflowRun.push({ id: "parked", workflowId: sysWf(w, "booking_cancelled").id, workspaceId: A, status: "waiting", result: {}, context: {}, startedAt: new Date(), isTest: false });
    await w.lifecycle.patch(A, "booking_cancelled", { enabled: false });
    expect(w.db.workflowRun.find((r) => r.id === "parked").status).toBe("cancelled");
  });

  it("rejected template shows resubmit and blocks enable", async () => {
    const w = lifecycleWorld();
    await w.lifecycle.setup(A, "booking_confirmed");
    w.setStatus("kewy_booking_confirmed_ar", "rejected", "INVALID_FORMAT");
    w.setStatus("kewy_booking_confirmed_en", "approved");
    expect(await failure(w.lifecycle.patch(A, "booking_confirmed", { enabled: true }))).toEqual({
      status: 409,
      body: { statusCode: 409, message: "lifecycle.template_rejected", language: "ar", reason: "INVALID_FORMAT" },
    });
    expect(sysWf(w, "booking_confirmed").status).toBe("draft");
    const row = (await w.lifecycle.list(A)).rows.find((r) => r.key === "booking_confirmed")!;
    expect(row.blockedReason).toBe("template_rejected");
    expect(row.variants?.ar).toMatchObject({ status: "rejected", rejectionReason: "INVALID_FORMAT" });

    // The reconcile marks it approved (Sync), then enabling works.
    w.setStatus("kewy_booking_confirmed_ar", "approved");
    const synced = await w.lifecycle.sync(A);
    expect(w.templates.list).toHaveBeenCalledWith(A);
    expect(synced.lastSyncedAt).not.toBeNull();
    expect(synced.rows.find((r) => r.key === "booking_confirmed")?.blockedReason).toBeNull();
    expect((await w.lifecycle.patch(A, "booking_confirmed", { enabled: true })).enabled).toBe(true);
  });

  it("enable needs both variants", async () => {
    const w = lifecycleWorld();
    await w.lifecycle.setup(A, "booking_confirmed");
    w.db.template = w.db.template.filter((t) => t.name !== "kewy_booking_confirmed_en");
    expect(await failure(w.lifecycle.patch(A, "booking_confirmed", { enabled: true }))).toEqual({
      status: 409,
      body: { statusCode: 409, message: "lifecycle.template_missing", language: "en" },
    });
    // Pending / paused variants enable (in review / paused) but send nothing.
    await w.lifecycle.setup(A, "booking_confirmed"); // recreates the missing EN one
    w.setStatus("kewy_booking_confirmed_ar", "pending");
    w.setStatus("kewy_booking_confirmed_en", "paused");
    expect((await w.lifecycle.patch(A, "booking_confirmed", { enabled: true })).enabled).toBe(true);
    await w.bookings.create(A, bookingInput());
    await w.flush();
    expect(w.zernio.sends).toHaveLength(0);
    expect(w.runs()[0].result.send).toEqual({ skipped: true, reason: "template_not_approved", conversationId: "convAr" });
  });
});

describe("locks and filters", () => {
  it("system workflow trigger is locked", async () => {
    const w = lifecycleWorld();
    await w.lifecycle.setup(A, "ticket_opened_staff");
    const id = sysWf(w, "ticket_opened_staff").id;
    const locked = { status: 409, body: { statusCode: 409, message: "workflows.system_locked" } };
    expect(await failure(w.workflows.update(A, id, { triggerType: "webhook" } as any))).toEqual(locked);
    expect(await failure(w.workflows.update(A, id, { steps: { entry: null, steps: {} } } as any))).toEqual(locked);
    expect(await failure(w.workflows.update(A, id, { name: "Renamed" } as any))).toEqual(locked);
    expect(await failure(w.workflows.remove(A, id))).toEqual(locked);
    expect((await w.workflows.activate(A, id)).status).toBe("active");
    expect((await w.workflows.deactivate(A, id)).status).toBe("draft");
    expect((await w.workflows.list(A))[0].systemKey).toBe("lifecycle.ticket_opened_staff");
    expect((await w.workflows.get(A, id)).systemKey).toBe("lifecycle.ticket_opened_staff");
  });

  it("pipelineKind filter matches only that kind; user workflow without filter still fires", async () => {
    const w = lifecycleWorld();
    await enabled(w, "ticket_opened_staff");
    await enabled(w, "new_lead_staff");
    const user = await w.workflows.create(A, {
      name: "Every ticket",
      triggerType: "ticket_created",
      triggerConfig: {},
      steps: { entry: "s", steps: { s: { id: "s", type: "send_whatsapp", config: { message: "hi" } } } },
    } as any);
    await w.workflows.activate(A, user.id);

    await w.tickets.createTicket(A, { pipelineId: "plSupport", stageId: "stOpen", contactId: "cAr", title: "Broken" } as any);
    await w.flush();
    const titles = () => w.notifications.sent.map((s) => s.n.title);
    expect(titles()).toEqual(["lifecycle.ticket_opened"]);
    expect(w.runs().filter((r) => r.workflowId === user.id)).toHaveLength(1);

    await w.tickets.createTicket(A, { pipelineId: "plLeads", stageId: "stNew", contactId: "cEn", title: "Lead" } as any);
    await w.flush();
    expect(titles()).toEqual(["lifecycle.ticket_opened", "lifecycle.new_lead"]);
    expect(w.runs().filter((r) => r.workflowId === user.id)).toHaveLength(2);
    // One pipeline lookup per event at most (the payload already carries the kind).
    expect(w.db.lifecycleDelivery.map((d) => d.occurrenceKey).sort()).toEqual(
      w.db.ticket.map((t) => `ticket_created:${t.id}`).sort(),
    );
  });
});

describe("reminders", () => {
  const NOW = new Date("2027-01-05T06:00:00.000Z");
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
  const appt = (id: string, startAt: Date, status = "confirmed", contactId = "cAr") => ({
    id,
    workspaceId: A,
    contactId,
    staffId: null,
    service: "Haircut",
    serviceAr: "قص شعر",
    startAt,
    durationMin: 30,
    status,
    source: "human",
    reminderSent: false,
    serviceId: null,
    resourceId: null,
    version: 0,
  });

  async function reminderWorld() {
    const w = lifecycleWorld();
    await w.lifecycle.setup(A, "booking_reminder");
    w.approveAll();
    await w.lifecycle.patch(A, "booking_reminder", { offsetMinutes: 60, enabled: true });
    return w;
  }

  it("reminder claimed once across overlapping ticks", async () => {
    const w = await reminderWorld();
    w.db.appointment.push(appt("a1", at(55)));
    await Promise.all([w.scheduler.tick({ now: NOW }), w.scheduler.tick({ now: NOW })]);
    expect(w.db.lifecycleDelivery).toHaveLength(1);
    expect(w.runs()).toHaveLength(1);
    expect(w.zernio.sends).toHaveLength(1);
    expect(w.zernio.sends[0].variables).toEqual(["ليلى", "قص شعر", expect.stringMatching(/الثلاثاء/), "09:55"]);
    expect(w.db.appointment[0].reminderSent).toBe(true);
    await w.scheduler.tick({ now: at(3) });
    expect(w.runs()).toHaveLength(1);
  });

  it("rescheduled booking gets a new reminder", async () => {
    const w = await reminderWorld();
    w.db.appointment.push(appt("a1", at(55)));
    await w.scheduler.tick({ now: NOW });
    w.db.appointment[0].startAt = at(58);
    await w.scheduler.tick({ now: NOW });
    expect(w.db.lifecycleDelivery.map((d) => d.occurrenceKey)).toEqual([
      `reminder:${at(55).toISOString()}:60`,
      `reminder:${at(58).toISOString()}:60`,
    ]);
    expect(w.zernio.sends).toHaveLength(2);
  });

  it("past reminder is skipped", async () => {
    const w = await reminderWorld();
    w.db.appointment.push(appt("a1", at(5)));
    await w.scheduler.tick({ now: NOW });
    expect(w.runs()).toHaveLength(0);
  });

  it("cancelled or completed booking gets no reminder", async () => {
    const w = await reminderWorld();
    w.db.appointment.push(appt("a1", at(55), "cancelled"), appt("a2", at(56), "completed"), appt("a3", at(57), "pending"));
    await w.scheduler.tick({ now: NOW });
    expect(w.db.lifecycleDelivery.map((d) => d.entityId)).toEqual(["a3"]);
  });

  it("a payment-locked workspace takes no claim; the next tick retries in the window", async () => {
    const w = await reminderWorld();
    w.db.appointment.push(appt("a1", at(55)));
    w.locked.value = true;
    await w.scheduler.tick({ now: NOW });
    expect(w.db.lifecycleDelivery).toHaveLength(0);
    w.locked.value = false;
    await w.scheduler.tick({ now: at(5) });
    expect(w.db.lifecycleDelivery).toHaveLength(1);
    // Only the listed workspaces are scanned.
    expect((await w.scheduler.tick({ now: NOW, workspaceIds: ["wsB"] })).started).toBe(0);
  });

  it("reminder respects offset bounds", async () => {
    const w = await reminderWorld();
    for (const offsetMinutes of [59, 10081, 90.5, "60"]) {
      expect({ offsetMinutes, e: await failure(w.lifecycle.patch(A, "booking_reminder", { offsetMinutes } as any)) }).toMatchObject({
        offsetMinutes,
        e: { status: 400, body: { message: "lifecycle.invalid_offset" } },
      });
    }
    expect(await failure(w.lifecycle.patch(A, "booking_confirmed", { offsetMinutes: 120 }))).toMatchObject({ status: 400 });
    expect((await w.lifecycle.patch(A, "booking_reminder", { offsetMinutes: 10080 })).offsetMinutes).toBe(10080);
  });
});

describe("booking and ticket triggers", () => {
  it("confirmed event sends once per startAt", async () => {
    const w = lifecycleWorld();
    await enabled(w, "booking_confirmed");
    await enabled(w, "booking_cancelled");
    const created: any = await w.bookings.create(A, bookingInput());
    await w.flush();
    expect(w.runs()).toHaveLength(1);
    expect(w.zernio.sends[0]).toMatchObject({ name: "kewy_booking_confirmed_ar", language: "ar" });
    // An unrelated update (a note) sends nothing.
    await w.bookings.update(A, created.id, { note: "bring ID" } as any);
    await w.flush();
    expect(w.runs()).toHaveLength(1);
    // A replayed event (same occurrence) sends nothing.
    const evt = w.events.emit.mock.calls.find((c: any[]) => c[1].triggerType === "appointment_confirmed")![1];
    await w.dispatch.handleTrigger(evt);
    expect(w.runs()).toHaveLength(1);
    // Cancel: one cancelled message.
    await w.bookings.update(A, created.id, { status: "cancelled" } as any);
    await w.flush();
    expect(w.zernio.sends.map((s) => s.name)).toEqual(["kewy_booking_confirmed_ar", "kewy_booking_cancelled_ar"]);
    expect(evt.payload.appointment).toMatchObject({ timeTextEn: "10:30", timeTextAr: "10:30", dateTextEn: "Tuesday 5 January" });
    expect(evt.payload.occurrenceKey).toBe("confirmed:2027-01-05T07:30:00.000Z");
  });

  it("unapproved variant falls back then skips", async () => {
    const w = lifecycleWorld();
    await enabled(w, "booking_confirmed");
    w.setStatus("kewy_booking_confirmed_ar", "pending");
    await w.bookings.create(A, bookingInput()); // Arabic conversation, AR not approved
    await w.flush();
    expect(w.zernio.sends.map((s) => [s.name, s.language])).toEqual([["kewy_booking_confirmed_en", "en"]]);
    expect(w.zernio.sends[0].variables).toEqual(["ليلى", "Haircut", "Tuesday 5 January", "10:30"]);
    w.setStatus("kewy_booking_confirmed_en", "pending");
    await w.bookings.create(A, bookingInput({ startAt: "2027-01-06T07:30:00.000Z" }));
    await w.flush();
    expect(w.zernio.sends).toHaveLength(1);
    expect(w.runs()[1].result.send).toMatchObject({ skipped: true, reason: "template_not_approved" });
  });

  it("language follows the last inbound script", async () => {
    const w = lifecycleWorld();
    await enabled(w, "booking_confirmed");
    await w.bookings.create(A, bookingInput({ contactId: "cAr" }));
    await w.bookings.create(A, bookingInput({ contactId: "cEn", startAt: "2027-01-06T07:30:00.000Z" }));
    await w.flush();
    expect(w.zernio.sends.map((s) => s.language)).toEqual(["ar", "en"]);
    expect(w.zernio.sends[1].variables[0]).toBe("Omar"); // first word of the name
  });

  it("disconnected number is skipped not rerouted", async () => {
    const w = lifecycleWorld();
    await enabled(w, "booking_confirmed");
    w.db.channel.find((c) => c.id === "chB").status = "disconnected";
    // A user workflow on the same trigger is gated the same way (ruling 8).
    const user = await w.workflows.create(A, {
      name: "Thanks",
      triggerType: "appointment_confirmed",
      steps: { entry: "t", steps: { t: { id: "t", type: "send_whatsapp_template", config: { name: "thanks", language: "en", variables: [] } } } },
    } as any);
    await w.workflows.activate(A, user.id);
    await w.bookings.create(A, bookingInput({ contactId: "cSecond" }));
    await w.flush();
    expect(w.zernio.sends).toHaveLength(0);
    const results = w.runs().map((r) => Object.values(r.result)[0]);
    expect(results).toEqual([
      { skipped: true, reason: "channel_disconnected", conversationId: "convSecond" },
      { skipped: true, reason: "channel_disconnected", conversationId: "convSecond" },
    ]);
    expect(w.runs().every((r) => r.status === "completed")).toBe(true);
  });

  it("opted-out contact gets no lifecycle message", async () => {
    const w = lifecycleWorld();
    await enabled(w, "booking_confirmed");
    await w.bookings.create(A, bookingInput({ contactId: "cOut" }));
    await w.flush();
    expect(w.zernio.sends).toHaveLength(0);
    expect(w.runs()[0].result.send).toEqual({ skipped: true, reason: "opted_out" });
    // The row counts it as a skip by reason.
    expect((await w.lifecycle.getRow(A, "booking_confirmed")).skipped30d).toEqual({ opted_out: 1 });
  });

  it("ticket resolved fires on won terminal stages only", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "setTimeout", "setInterval", "queueMicrotask"] });
    try {
      jest.setSystemTime(new Date("2027-01-05T08:00:00Z"));
      const w = lifecycleWorld();
      await enabled(w, "ticket_resolved");
      const t1: any = await w.tickets.createTicket(A, { pipelineId: "plSupport", stageId: "stOpen", contactId: "cAr", title: "Broken", conversationId: "convAr" } as any);
      const t2: any = await w.tickets.createTicket(A, { pipelineId: "plSupport", stageId: "stOpen", contactId: "cEn", title: "Other", conversationId: "convEn" } as any);
      await w.flush();
      await w.tickets.moveTicket(A, t1.id, { stageId: "stResolved" } as any);
      await w.tickets.moveTicket(A, t2.id, { stageId: "stDismissed", lostReason: "n/a" } as any);
      await w.flush();
      expect(w.zernio.sends.map((s) => [s.name, s.conversationId])).toEqual([["kewy_ticket_resolved_ar", "convAr"]]);
      expect(w.zernio.sends[0].variables).toEqual(["ليلى", String(t1.number)]);
      // Reopen and resolve again: a new occurrence.
      jest.setSystemTime(new Date("2027-01-05T09:00:00Z"));
      await w.tickets.reopenTicket(A, t1.id);
      jest.setSystemTime(new Date("2027-01-05T10:00:00Z"));
      await w.tickets.moveTicket(A, t1.id, { stageId: "stResolved" } as any);
      await w.flush();
      expect(w.zernio.sends).toHaveLength(2);
      expect(w.db.lifecycleDelivery.map((d) => d.occurrenceKey)).toEqual([
        "ticket_resolved:" + t1.id + ":2027-01-05T08:00:00.000Z",
        "ticket_resolved:" + t1.id + ":2027-01-05T10:00:00.000Z",
      ]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("recipients", () => {
  it("staff recipients are validated without revealing which id is foreign", async () => {
    const w = lifecycleWorld();
    await w.lifecycle.setup(A, "new_lead_staff");
    const bad = { status: 400, body: { statusCode: 400, message: "lifecycle.invalid_recipient" } };
    expect(await failure(w.lifecycle.patch(A, "new_lead_staff", { recipient: { kind: "members", userIds: ["uOwner", "uB"] } }))).toEqual(bad);
    expect(await failure(w.lifecycle.patch(A, "new_lead_staff", { recipient: { kind: "customer" } }))).toEqual(bad);
    expect(await failure(w.lifecycle.patch(A, "booking_confirmed", { recipient: { kind: "permitted" } }))).toEqual(bad);
    expect(await failure(w.lifecycle.patch(A, "new_lead_staff", { recipient: { kind: "members", userIds: Array.from({ length: 21 }, (_, i) => `u${i}`) } }))).toEqual(bad);
    const row = await w.lifecycle.patch(A, "new_lead_staff", { recipient: { kind: "members", userIds: ["uAdmin", "uAdmin"] } });
    expect(row.recipient).toEqual({ kind: "members", userIds: ["uAdmin"] });
    expect((await w.lifecycle.patch(A, "new_lead_staff", { recipient: { kind: "assignee" } })).recipient).toEqual({ kind: "assignee", userIds: [] });
  });
});
