import { validate } from "class-validator";
import { IsTimezone, isValidTimezone } from "./is-timezone";
import { CreateWorkspaceDto, UpdateWorkspaceDto } from "../workspaces/workspaces.dto";

describe("timezone validation", () => {
  it("accepts IANA names and rejects junk", () => {
    expect(isValidTimezone("Asia/Riyadh")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone(5)).toBe(false);
  });

  it("decorator yields a validation error for invalid values", async () => {
    class D {
      @IsTimezone() tz!: string;
    }
    const bad = Object.assign(new D(), { tz: "Mars/Olympus" });
    expect((await validate(bad)).length).toBe(1);
    expect((await validate(Object.assign(new D(), { tz: "Europe/Paris" }))).length).toBe(0);
  });

  it("workspace DTOs reject an invalid timezone but allow omission", async () => {
    const mk = (C: any, o: object) => Object.assign(new C(), o);
    expect((await validate(mk(CreateWorkspaceDto, { name: "x", timezone: "Nope/Zone" }))).length).toBe(1);
    expect((await validate(mk(UpdateWorkspaceDto, { timezone: "Nope/Zone" }))).length).toBe(1);
    expect((await validate(mk(UpdateWorkspaceDto, { timezone: "Asia/Dubai" }))).length).toBe(0);
    expect((await validate(mk(UpdateWorkspaceDto, {}))).length).toBe(0);
  });
});
