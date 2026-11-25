/* eslint-disable @typescript-eslint/no-explicit-any */
import { endpoint, T0, U, webhooksWorld, WS, WS2 } from "./__fixtures__/webhooks-world";
import { buildPayload, CONTACT_FIELDS } from "./webhook-payloads";
import { WORKFLOW_TRIGGER_EVENT } from "../workflows/workflow-events";
import { eventIdFor, fromWorkflowTrigger } from "./webhook-events";

describe("webhook payloads and the outbox", () => {
  it("payload serializer exposes only whitelisted fields", async () => {
    const w = webhooksWorld();
    const data: any = await buildPayload(w.prisma, { workspaceId: WS, type: "contact.created", entityId: "c1" });
    expect(Object.keys(data)).toEqual(["contact"]);
    expect(Object.keys(data.contact).sort()).toEqual([...CONTACT_FIELDS].sort());
    expect(data.contact).toEqual({
      id: "c1",
      name: "Sara Ali",
      firstName: "Sara",
      lastName: "Ali",
      email: "sara@example.com",
      phone: "966500000001",
      lifecycle: "lead",
      source: "whatsapp",
      tags: ["vip"],
      createdAt: T0.toISOString(),
    });
    const text = JSON.stringify(data);
    for (const hidden of ["hjz-9", "wa-123", "9000", U.owner, "marketingOptOut", "industry", "retail"]) expect({ hidden, leaked: text.includes(hidden) }).toEqual({ hidden, leaked: false });
    // Another workspace's record is never serialized.
    expect(await buildPayload(w.prisma, { workspaceId: WS2, type: "contact.created", entityId: "c1" })).toBeNull();
  });

  it("event of workspace A never reaches workspace B endpoint", async () => {
    const w = webhooksWorld();
    const a = await endpoint(w, ["contact.created"], WS);
    const b = await endpoint(w, ["contact.created"], WS2);
    expect(await w.listener.enqueue({ workspaceId: WS, type: "contact.created", entityId: "c1" })).toBe(1);
    expect(w.db.webhookDelivery.map((d: any) => [d.endpointId, d.workspaceId])).toEqual([[a.id, WS]]);
    // A forged emit naming B with A's record id inserts nothing.
    expect(await w.listener.enqueue({ workspaceId: WS2, type: "contact.created", entityId: "c1" })).toBe(0);
    expect(w.db.webhookDelivery.some((d: any) => d.endpointId === b.id)).toBe(false);
    // B's own contact reaches B only.
    expect(await w.listener.enqueue({ workspaceId: WS2, type: "contact.created", entityId: "c2" })).toBe(1);
    expect(w.db.webhookDelivery.filter((d: any) => d.endpointId === b.id)).toHaveLength(1);
  });

  it("duplicate emit inserts one delivery per endpoint", async () => {
    const w = webhooksWorld();
    await endpoint(w, ["contact.created"]);
    await endpoint(w, ["contact.created", "ticket.created"]);
    await endpoint(w, ["ticket.created"]); // not subscribed
    const off = await endpoint(w, ["contact.created"]);
    await w.service.update(WS, { userId: U.owner }, off.id, { active: false }); // inactive
    const trigger = { workspaceId: WS, triggerType: "contact_created", payload: { contact: { id: "c1", name: "Sara Ali" } } };
    await w.listener.onWorkflowTrigger(trigger);
    await w.listener.onWorkflowTrigger(trigger);
    await w.listener.enqueue({ workspaceId: WS, type: "contact.created", entityId: "c1" });
    expect(w.db.webhookDelivery).toHaveLength(2);
    const ids = new Set(w.db.webhookDelivery.map((d: any) => d.eventId));
    expect([...ids]).toEqual([eventIdFor(WS, "contact.created", "c1")]);
    expect(w.db.webhookDelivery[0].payload).toMatchObject({ id: [...ids][0], type: "contact.created", workspaceId: WS, data: { contact: { id: "c1" } } });
  });

  it("maps the five workflow triggers and ignores the rest", () => {
    const m = (triggerType: string, payload: any) => fromWorkflowTrigger({ workspaceId: WS, triggerType, payload });
    expect(m("contact_created", { contact: { id: "c" } })).toMatchObject({ type: "contact.created", entityId: "c" });
    expect(m("message_received", { message: { id: "m", body: "hi" } })).toMatchObject({ type: "message.received", entityId: "m" });
    expect(m("message_received", { message: { body: "hi" } })).toBeNull();
    expect(m("ticket_created", { ticket: { id: "t" } })).toMatchObject({ type: "ticket.created", entityId: "t" });
    expect(m("ticket_stage_changed", { ticket: { id: "t", stageId: "s2", enteredStageAt: T0 } })).toMatchObject({
      type: "ticket.stage_changed",
      entityId: "t",
      occurrence: `t:s2:${T0.toISOString()}`,
    });
    expect(m("appointment_completed", { appointment: { id: "a" } })).toMatchObject({ type: "booking.completed", entityId: "a" });
    for (const other of ["ticket_resolved", "sale_completed", "appointment_confirmed", "schedule"]) expect(m(other, {})).toBeNull();
    expect(WORKFLOW_TRIGGER_EVENT).toBe("workflow.trigger");
  });

  it("a failing re-read never throws into the emitter", async () => {
    const w = webhooksWorld();
    await endpoint(w);
    w.prisma.contact.findFirst = jest.fn(async () => {
      throw new Error("db down");
    });
    await expect(w.listener.enqueue({ workspaceId: WS, type: "contact.created", entityId: "c1" })).resolves.toBe(0);
  });
});
