import { A, B, booking, catalogWorld, failure } from "../bookings/catalog-test-world";

describe("service and staff crud", () => {
  describe("services", () => {
    it("creates a service; price is a decimal string; defaults applied", async () => {
      const { services } = catalogWorld();
      const s = await services.create(A, { name: "  Haircut ", nameAr: "قص شعر", durationMin: 45, price: "120.5" });
      expect(s).toMatchObject({
        name: "Haircut",
        nameAr: "قص شعر",
        durationMin: 45,
        price: "120.50",
        currency: "SAR",
        color: "info",
        active: true,
        archivedAt: null,
        version: 0,
        staffIds: [],
        upcomingCount: 0,
      });
      const free = await services.create(A, { name: "Consult", durationMin: 15, price: null, color: "ok", currency: "usd" });
      expect(free).toMatchObject({ price: null, color: "ok", currency: "USD", nameAr: "Consult" });
      const exact = await services.create(A, { name: "Nails", durationMin: 30, price: 80 });
      expect(exact.price).toBe("80.00");
      expect(typeof exact.price).toBe("string");
    });

    it("refuses bad fields with bookings.* keys", async () => {
      const { services } = catalogWorld();
      expect(await failure(services.create(A, { name: "X", durationMin: 4 }))).toEqual({
        status: 400,
        body: { statusCode: 400, message: "bookings.duration_invalid", min: 5, max: 1440 },
      });
      expect((await failure(services.create(A, { name: "X", durationMin: 1441 }))).body.message).toBe("bookings.duration_invalid");
      expect((await failure(services.create(A, { name: "X", durationMin: 30.5 }))).body.message).toBe("bookings.duration_invalid");
      expect((await failure(services.create(A, { name: "X", durationMin: "30" as never }))).body.message).toBe("bookings.duration_invalid");
      expect(await services.create(A, { name: "Min", durationMin: 5 })).toMatchObject({ durationMin: 5 });
      expect(await services.create(A, { name: "Max", durationMin: 1440 })).toMatchObject({ durationMin: 1440 });
      const color = await failure(services.create(A, { name: "X", durationMin: 30, color: "purple" }));
      expect(color.status).toBe(400);
      expect(color.body).toMatchObject({ message: "bookings.color_invalid", allowed: ["ink", "info", "ok", "warn", "bad", "accent", "human"] });
      for (const price of ["-1", "1.234", "abc", 1e20]) {
        expect((await failure(services.create(A, { name: "X", durationMin: 30, price }))).body.message).toBe("bookings.price_invalid");
      }
      expect((await failure(services.create(A, { name: "X", durationMin: 30, currency: "riyal" }))).body.message).toBe("bookings.currency_invalid");
      expect((await failure(services.create(A, { name: "  ", durationMin: 30 }))).body.message).toBe("bookings.name_required");
    });

    it("lists by active and q over both names with Arabic normalization", async () => {
      const { services } = catalogWorld();
      const cut = await services.create(A, { name: "Haircut", nameAr: "قَصّة شعر", durationMin: 30 });
      const color = await services.create(A, { name: "Hair colour", nameAr: "صبغة", durationMin: 90 });
      const old = await services.create(A, { name: "Shave", nameAr: "حلاقة ذقن", durationMin: 20 });
      await services.update(A, old.id, { active: false });
      await services.create(B, { name: "Haircut B", durationMin: 30 });

      const ids = async (o: { active?: boolean; q?: string }) => (await services.list(A, o)).items.map((s) => s.id);
      expect(await ids({})).toEqual([cut.id, color.id, old.id]);
      expect(await ids({ active: true })).toEqual([cut.id, color.id]);
      expect(await ids({ active: false })).toEqual([old.id]);
      expect(await ids({ q: "HAIR" })).toEqual([cut.id, color.id]);
      expect(await ids({ q: "قصه" })).toEqual([cut.id]); // taa marbuta, no diacritics
      expect(await ids({ q: "صبغه" })).toEqual([color.id]);
      expect(await ids({ q: "حلاقه", active: true })).toEqual([]);
    });

    it("patches with version; a stale version is 409 bookings.version_conflict {current}", async () => {
      const { services } = catalogWorld();
      const s = await services.create(A, { name: "Haircut", durationMin: 30 });
      const v1 = await services.update(A, s.id, { durationMin: 45, price: "99.9", version: 0 });
      expect(v1).toMatchObject({ durationMin: 45, price: "99.90", version: 1 });
      const stale = await failure(services.update(A, s.id, { name: "Cut", version: 0 }));
      expect(stale.status).toBe(409);
      expect(stale.body.message).toBe("bookings.version_conflict");
      expect(stale.body.current).toMatchObject({ id: s.id, name: "Haircut", durationMin: 45, version: 1 });
      // Without a version, no check; the version still increments.
      expect(await services.update(A, s.id, { name: "Cut" })).toMatchObject({ name: "Cut", version: 2 });
      // Bad fields on patch.
      expect((await failure(services.update(A, s.id, { durationMin: 4 }))).body.message).toBe("bookings.duration_invalid");
      expect((await failure(services.update(A, s.id, { color: "nope" }))).body.message).toBe("bookings.color_invalid");
      // price null clears it.
      expect(await services.update(A, s.id, { price: null })).toMatchObject({ price: null });
    });

    it("links staff through PUT; foreign or unknown staff ids are 404", async () => {
      const { services, staff } = catalogWorld();
      const s = await services.create(A, { name: "Haircut", durationMin: 30 });
      const r1 = await staff.create(A, { name: "Sara" });
      const r2 = await staff.create(A, { name: "Lina" });
      const rB = await staff.create(B, { name: "Other" });
      expect(await services.setStaff(A, s.id, [r1.id, r2.id, r1.id])).toMatchObject({ staffIds: [r1.id, r2.id] });
      expect((await staff.get(A, r1.id)).serviceIds).toEqual([s.id]);
      expect(await failure(services.setStaff(A, s.id, [r1.id, rB.id]))).toEqual({
        status: 404,
        body: { statusCode: 404, message: "bookings.resource_not_found" },
      });
      expect((await failure(services.setStaff(A, s.id, ["nope"]))).status).toBe(404);
      // A refused PUT changes nothing.
      expect((await services.get(A, s.id)).staffIds).toEqual([r1.id, r2.id]);
      expect(await services.setStaff(A, s.id, [r2.id])).toMatchObject({ staffIds: [r2.id] });
      expect(await services.setStaff(A, s.id, [])).toMatchObject({ staffIds: [] });
      // Create can link staff directly.
      const withStaff = await services.create(A, { name: "Beard", durationMin: 20, staffIds: [r1.id] });
      expect(withStaff.staffIds).toEqual([r1.id]);
      expect((await failure(services.create(A, { name: "Bad", durationMin: 20, staffIds: [rB.id] }))).status).toBe(404);
    });

    it("upcomingCount counts future pending/confirmed bookings only", async () => {
      const { services, prisma } = catalogWorld();
      const s = await services.create(A, { name: "Haircut", durationMin: 30 });
      prisma.db.appointment.push(
        booking({ serviceId: s.id, status: "confirmed" }),
        booking({ serviceId: s.id, status: "pending" }),
        booking({ serviceId: s.id, status: "cancelled" }),
        booking({ serviceId: s.id, status: "completed", startAt: new Date(Date.now() - 86_400_000) }),
        booking({ serviceId: s.id, status: "confirmed", startAt: new Date(Date.now() - 86_400_000) }),
      );
      expect((await services.get(A, s.id)).upcomingCount).toBe(2);
    });

    it("archived services cannot be re-activated by PATCH (restore does it)", async () => {
      const { services, prisma } = catalogWorld();
      const s = await services.create(A, { name: "Haircut", durationMin: 30 });
      prisma.db.appointment.push(booking({ serviceId: s.id }));
      await services.remove(A, s.id);
      expect((await failure(services.update(A, s.id, { active: true }))).body.message).toBe("bookings.service_archived");
      expect(await services.restore(A, s.id)).toMatchObject({ active: true, archivedAt: null });
    });
  });
});
