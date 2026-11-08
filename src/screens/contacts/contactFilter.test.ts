import { describe, expect, it } from "vitest";
import {
  EMPTY_CONTACT_FILTER, activeCount, decodeContactFilter, encodeContactFilter, opsForType, toBulkFilter, toQuery,
  type ContactFilter,
} from "./contactFilter";

const f = (p: Partial<ContactFilter>): ContactFilter => ({ ...EMPTY_CONTACT_FILTER, ...p });

describe("toQuery", () => {
  it("is empty for the empty filter", () => {
    expect(toQuery(EMPTY_CONTACT_FILTER).toString()).toBe("");
  });
  it("joins lifecycle and tags with commas and sets tagMode only when 'all'", () => {
    const q = toQuery(f({ lifecycle: ["lead", "customer"], tags: ["VIP", "Hot"], tagMode: "all" }));
    expect(q.get("lifecycle")).toBe("lead,customer");
    expect(q.get("tags")).toBe("VIP,Hot");
    expect(q.get("tagMode")).toBe("all");
    expect(toQuery(f({ tags: ["VIP"] })).has("tagMode")).toBe(false);
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

describe("toBulkFilter", () => {
  it("uses JSON-typed keys", () => {
    expect(
      toBulkFilter(f({ lifecycle: ["lead"], tags: ["a"], tagMode: "all", optOut: true, ownerId: "none", fields: [{ defId: "d", op: "unset" }] }), { q: "x" }),
    ).toEqual({
      q: "x", lifecycle: ["lead"], tags: ["a"], tagMode: "all", ownerId: "none", optOut: true, fields: [{ defId: "d", op: "unset" }],
    });
  });
  it("is empty for empty", () => {
    expect(toBulkFilter(EMPTY_CONTACT_FILTER)).toEqual({});
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
