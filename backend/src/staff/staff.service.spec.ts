import { A, B, catalogWorld, failure } from "../bookings/catalog-test-world";

const WEEK = {
  tue: [{ from: "16:00", to: "21:00" }, { from: "09:00", to: "13:00" }],
  sun: [{ from: "09:00", to: "17:00" }],
};

describe("service and staff crud", () => {
  describe("staff", () => {
    it("creates a resource with a validated, sorted schedule", async () => {
      const { staff } = catalogWorld();
      const r = await staff.create(A, { name: "Sara", nameAr: "سارة", role: "Stylist", color: "human", schedule: WEEK });
      expect(r).toMatchObject({
        name: "Sara",
        nameAr: "سارة",
        role: "Stylist",
        color: "human",
        userId: null,
        user: null,
        schedule: {
          tue: [{ from: "09:00", to: "13:00" }, { from: "16:00", to: "21:00" }],
          sun: [{ from: "09:00", to: "17:00" }],
        },
        scheduleConfigured: true,
        active: true,
        archivedAt: null,
        version: 0,
        serviceIds: [],
        upcomingCount: 0,
      });
      const bare = await staff.create(A, { name: "Room 1" });
      expect(bare).toMatchObject({ schedule: {}, scheduleConfigured: false, color: "accent", nameAr: null, role: null });
    });

    it("a malformed schedule is 400 bookings.schedule_invalid {day, index, reason}", async () => {
      const { staff } = catalogWorld();
      expect(await failure(staff.create(A, { name: "X", schedule: { mon: [{ from: "25:00", to: "26:00" }] } }))).toEqual({
        status: 400,
        body: { statusCode: 400, message: "bookings.schedule_invalid", day: "mon", index: 0, reason: "time_invalid" },
      });
      const r = await staff.create(A, { name: "X" });
      expect((await failure(staff.update(A, r.id, { schedule: { funday: [] } }))).body).toMatchObject({
        message: "bookings.schedule_invalid",
        day: "funday",
        reason: "unknown_day",
      });
      expect((await failure(staff.create(A, { name: "X", color: "pink" }))).body.message).toBe("bookings.color_invalid");
      expect((await failure(staff.create(A, { name: "" }))).body.message).toBe("bookings.name_required");
    });

    it("links a member: must be a member of this workspace; one resource per member", async () => {
      const { staff } = catalogWorld();
      const r = await staff.create(A, { name: "Agent", userId: "uAgent" });
      expect(r).toMatchObject({ userId: "uAgent", user: { id: "uAgent", name: "Agent A" } });
      // A member of another workspace, or no user at all.
      expect(await failure(staff.create(A, { name: "X", userId: "uOther" }))).toEqual({
        status: 400,
        body: { statusCode: 400, message: "bookings.not_a_member" },
      });
      expect((await failure(staff.create(A, { name: "X", userId: "ghost" }))).body.message).toBe("bookings.not_a_member");
      // The same member twice.
      expect(await failure(staff.create(A, { name: "Again", userId: "uAgent" }))).toEqual({
        status: 409,
        body: { statusCode: 409, message: "bookings.member_has_resource", resourceId: r.id },
      });
      // Re-linking another resource to the member is refused too; unlinking and moving works.
      const other = await staff.create(A, { name: "Other" });
      expect((await failure(staff.update(A, other.id, { userId: "uAgent" }))).status).toBe(409);
      // Patching the resource with its own member is fine.
      expect(await staff.update(A, r.id, { userId: "uAgent", role: "Lead" })).toMatchObject({ userId: "uAgent", role: "Lead" });
      await staff.update(A, r.id, { userId: null });
      expect(await staff.update(A, other.id, { userId: "uAgent" })).toMatchObject({ userId: "uAgent" });
    });

    it("a concurrent link of the same member loses on the unique index with the same 409", async () => {
      const { staff } = catalogWorld();
      const results = await Promise.allSettled([
        staff.create(A, { name: "One", userId: "uOwner" }),
        staff.create(A, { name: "Two", userId: "uOwner" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason.getResponse()).toMatchObject({ statusCode: 409, message: "bookings.member_has_resource" });
    });

    it("lists by active and q over both names (Arabic normalized)", async () => {
      const { staff } = catalogWorld();
      const a = await staff.create(A, { name: "Ahmed", nameAr: "أحمد" });
      const b = await staff.create(A, { name: "Sara", nameAr: "سارة" });
      await staff.update(A, b.id, { active: false });
      await staff.create(B, { name: "Ahmed B", nameAr: "أحمد" });
      const ids = async (o: { active?: boolean; q?: string }) => (await staff.list(A, o)).items.map((r) => r.id);
      expect(await ids({})).toEqual([a.id, b.id]);
      expect(await ids({ active: true })).toEqual([a.id]);
      expect(await ids({ active: false })).toEqual([b.id]);
      expect(await ids({ q: "احمد" })).toEqual([a.id]);
      expect(await ids({ q: "ساره" })).toEqual([b.id]);
      expect(await ids({ q: "sar" })).toEqual([b.id]);
    });

    it("patches with version; stale → 409 with current", async () => {
      const { staff } = catalogWorld();
      const r = await staff.create(A, { name: "Sara" });
      expect(await staff.update(A, r.id, { schedule: WEEK, version: 0 })).toMatchObject({ version: 1, scheduleConfigured: true });
      const stale = await failure(staff.update(A, r.id, { name: "S", version: 0 }));
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ message: "bookings.version_conflict", current: { id: r.id, name: "Sara", version: 1 } });
    });

    it("links services through PUT; foreign or archived services refused", async () => {
      const { staff, services, prisma } = catalogWorld();
      const r = await staff.create(A, { name: "Sara" });
      const s1 = await services.create(A, { name: "Cut", durationMin: 30 });
      const s2 = await services.create(A, { name: "Colour", durationMin: 90 });
      const sB = await services.create(B, { name: "Other", durationMin: 30 });
      expect(await staff.setServices(A, r.id, [s1.id, s2.id])).toMatchObject({ serviceIds: [s1.id, s2.id] });
      expect((await services.get(A, s2.id)).staffIds).toEqual([r.id]);
      expect(await failure(staff.setServices(A, r.id, [sB.id]))).toEqual({
        status: 404,
        body: { statusCode: 404, message: "bookings.service_not_found" },
      });
      prisma.db.service.find((s: { id: string }) => s.id === s2.id).archivedAt = new Date();
      expect((await failure(staff.setServices(A, r.id, [s2.id]))).body.message).toBe("bookings.service_archived");
      expect(await staff.setServices(A, r.id, [s1.id])).toMatchObject({ serviceIds: [s1.id] });
    });
  });
});
