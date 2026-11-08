import { describe, expect, it } from "vitest";
import {
  EMPTY_CONTACT_FILTER, activeCount, decodeContactFilter, encodeContactFilter, isSelectAllCurrent, opsForType, pruneFieldFilters, toQuery,
  type ContactFilter,
} from "./contactFilter";

const f = (p: Partial<ContactFilter>): ContactFilter => ({ ...EMPTY_CONTACT_FILTER, ...p });

describe("toQuery", () => {
  it("is empty for the empty filter", () => {
    expect(toQuery(EMPTY_CONTACT_FILTER).toString()).toBe("");
  });
  it("joins lifecycle with commas, sends tags as a JSON array, tagMode only when 'all'", () => {
    const q = toQuery(f({ lifecycle: ["lead", "customer"], tags: ["VIP", "Hot"], tagMode: "all" }));
    expect(q.get("lifecycle")).toBe("lead,customer");
    expect(q.get("tags")).toBe('["VIP","Hot"]');
    expect(q.get("tagMode")).toBe("all");
    expect(toQuery(f({ tags: ["VIP"] })).has("tagMode")).toBe(false);
  });
  it("keeps a tag that contains a comma whole", () => {
    const q = toQuery(f({ tags: ["Riyadh, KSA", "VIP"] }));
    expect(JSON.parse(q.get("tags")!)).toEqual(["Riyadh, KSA", "VIP"]);
    // Survives URL encoding round-trip.
    expect(new URLSearchParams(q.toString()).get("tags")).toBe('["Riyadh, KSA","VIP"]');
  });
  it("owner: id or none", () => {
    expect(toQuery(f({ ownerId: "u1" })).get("ownerId")).toBe("u1");
    expect(toQuery(f({ ownerId: "none" })).get("ownerId")).toBe("none");
  });
  it("pipeline/stage and booleans", () => {
    const q = toQuery(f({ pipelineId: "p", stageId: "s", optOut: false, notALead: true }));
    expect(q.get("pipelineId")).toBe("p");
    expect(q.get("stageId")).toBe("s");
    expect(q.get("optOut")).toBe("false");
    expect(q.get("notALead")).toBe("true");
  });
  it("drops stageId without pipelineId", () => {
    expect(toQuery(f({ stageId: "s" })).has("stageId")).toBe(false);
  });
  it("fields serialise as JSON, with value omitted for set/unset", () => {
    const q = toQuery(f({ fields: [{ defId: "d1", op: "contains", value: "ع" }, { defId: "d2", op: "set" }] }));
    expect(JSON.parse(q.get("fields")!)).toEqual([{ defId: "d1", op: "contains", value: "ع" }, { defId: "d2", op: "set" }]);
  });
  it("includes extras q/segmentId", () => {
    const q = toQuery(EMPTY_CONTACT_FILTER, { q: "ali", segmentId: "g" });
    expect(q.get("q")).toBe("ali");
    expect(q.get("segmentId")).toBe("g");
  });
});

describe("activeCount", () => {
  it("counts each active facet; each field filter counts", () => {
    expect(activeCount(EMPTY_CONTACT_FILTER)).toBe(0);
    expect(
      activeCount(f({ lifecycle: ["a"], tags: ["t"], ownerId: "none", pipelineId: "p", optOut: false, notALead: true, fields: [{ defId: "1", op: "set" }, { defId: "2", op: "set" }] })),
    ).toBe(8);
  });
});

describe("opsForType", () => {
  it("matches the backend", () => {
    expect(opsForType("text")).toEqual(["eq", "contains", "set", "unset"]);
    expect(opsForType("number")).toEqual(["eq", "gt", "lt", "set", "unset"]);
    expect(opsForType("date")).toEqual(["eq", "gt", "lt", "set", "unset"]);
    expect(opsForType("select")).toEqual(["eq", "set", "unset"]);
    expect(opsForType("boolean")).toEqual(["eq", "set", "unset"]);
  });
});

describe("hash encoding", () => {
  it("round-trips incl. Arabic", () => {
    const x = f({ tags: ["عميل"], fields: [{ defId: "d", op: "eq", value: "نعم" }], ownerId: "none" });
    expect(decodeContactFilter(encodeContactFilter(x))).toEqual(x);
  });
  it("sanitises garbage", () => {
    expect(decodeContactFilter("%%%")).toEqual(EMPTY_CONTACT_FILTER);
    expect(decodeContactFilter(encodeContactFilter({ lifecycle: "x", optOut: "yes", fields: [{ op: "zzz" }] } as never))).toEqual(EMPTY_CONTACT_FILTER);
  });
});

describe("isSelectAllCurrent", () => {
  it("accepts only an unchanged query and selection", () => {
    expect(isSelectAllCurrent({ query: "a=1", selectionVersion: 3 }, { query: "a=1", selectionVersion: 3 })).toBe(true);
    expect(isSelectAllCurrent({ query: "a=1", selectionVersion: 3 }, { query: "a=2", selectionVersion: 3 })).toBe(false);
    expect(isSelectAllCurrent({ query: "a=1", selectionVersion: 3 }, { query: "a=1", selectionVersion: 4 })).toBe(false);
  });
});

describe("pruneFieldFilters", () => {
  it("removes conditions on unknown defs and keeps identity when nothing changes", () => {
    const x = f({ fields: [{ defId: "a", op: "set" }, { defId: "gone", op: "set" }] });
    expect(pruneFieldFilters(x, new Set(["a"])).fields).toEqual([{ defId: "a", op: "set" }]);
    expect(pruneFieldFilters(x, new Set(["a", "gone"]))).toBe(x);
  });
});
