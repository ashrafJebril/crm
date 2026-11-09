import { makeFakePrisma } from "../../channels/test-prisma";
import { streamAudience } from "./audience-stream";

describe("streamAudience", () => {
  const contact = (id: string, ws = "ws1") => ({
    id,
    workspaceId: ws,
    name: `N ${id}`,
    firstName: null,
    lastName: null,
    email: null,
    phone: `+96279000${id.slice(1).padStart(4, "0")}`,
    lifecycle: "lead",
    marketingOptOut: false,
  });

  const build = () => {
    const contacts = Array.from({ length: 25 }, (_, i) => contact(`c${String(i + 1).padStart(2, "0")}`));
    contacts.push(contact("c99", "ws2"));
    return makeFakePrisma({
      contact: contacts,
      segmentMember: contacts.filter((_, i) => i % 2 === 0).map((c) => ({ segmentId: "seg", contactId: c.id })),
      customFieldValue: [
        { defId: "d-city", contactId: "c01", value: "Amman" },
        { defId: "d-city", contactId: "c24", value: "Irbid" },
        { defId: "d-other", contactId: "c01", value: "x" },
        { defId: "d-city", contactId: "c99", value: "Foreign" },
      ],
    });
  };

  it("streams the audience in keyset pages in id order, each with its custom values", async () => {
    const prisma = build();
    const pages = [];
    for await (const p of streamAudience(prisma, "ws1", null, ["d-city"], 10)) pages.push(p);
    expect(pages.map((p) => p.contacts.length)).toEqual([10, 10, 5]);
    const ids = pages.flatMap((p) => p.contacts.map((c) => c.id));
    expect(ids).toEqual([...ids].sort());
    expect(ids).not.toContain("c99");
    expect(pages[0].customValues.get("c01")).toEqual({ "d-city": "Amman" });
    expect(pages[2].customValues.get("c24")).toEqual({ "d-city": "Irbid" });
    expect(pages[1].customValues.size).toBe(0);
    // Every contact query is workspace-scoped and keyset-paged.
    for (const call of prisma.contact.findMany.mock.calls) {
      expect(call[0]).toMatchObject({ where: { workspaceId: "ws1" }, orderBy: { id: "asc" }, take: 10 });
    }
    expect(prisma.contact.findMany.mock.calls[1][0].where.id).toEqual({ gt: pages[0].contacts.at(-1)!.id });
    // One value query per page, only for the requested defs.
    expect(prisma.customFieldValue.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.customFieldValue.findMany.mock.calls[0][0].where.defId).toEqual({ in: ["d-city"] });
  });

  it("filters by segment and skips the value query without defs", async () => {
    const prisma = build();
    const ids: string[] = [];
    for await (const p of streamAudience(prisma, "ws1", "seg", [], 1000)) ids.push(...p.contacts.map((c) => c.id));
    expect(ids).toHaveLength(13);
    expect(prisma.customFieldValue.findMany).not.toHaveBeenCalled();
  });
});
