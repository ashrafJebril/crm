import { describe, expect, it } from "vitest";
import { followUpContactId } from "./followUpGate";

describe("followUpContactId", () => {
  it("returns the stored contact for a DB conversation when allowed", () => {
    expect(followUpContactId({ id: "conv1", contactId: "c1" }, true)).toBe("c1");
  });

  it("is null without contacts.update", () => {
    expect(followUpContactId({ id: "conv1", contactId: "c1" }, false)).toBeNull();
  });

  it("is null for live Facebook/Instagram threads", () => {
    expect(followUpContactId({ id: "t_123", contactId: "c1" }, true)).toBeNull();
    expect(followUpContactId({ id: "ig:456", contactId: "c1" }, true)).toBeNull();
  });

  it("is null with no contact, or a contact id that is just the thread id", () => {
    expect(followUpContactId({ id: "conv1", contactId: "" }, true)).toBeNull();
    expect(followUpContactId({ id: "conv1", contactId: null }, true)).toBeNull();
    expect(followUpContactId({ id: "conv1", contactId: "conv1" }, true)).toBeNull();
  });
});
