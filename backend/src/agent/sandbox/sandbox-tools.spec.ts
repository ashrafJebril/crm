/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";
import { SANDBOX_READ_TOOLS } from "../agent-constants";
import { displayArgs, isSandboxReadTool, sandboxTools, SIMULATED_NOTE, simulatedResult, toolDefinitions, toolInputSchema } from "./sandbox-tools";
import { services, seed } from "./sandbox-test-world";
import { makeFakePrisma } from "../../channels/test-prisma";

describe("sandbox tool policy", () => {
  it("only the listed read tools run; the decision is the tool id", () => {
    for (const id of SANDBOX_READ_TOOLS) expect(isSandboxReadTool(id)).toBe(true);
    for (const id of ["create_appointment", "update_appointment", "cancel_appointment", "create_contact", "update_contact", "new_tool", "LIST_PHOTOS", ""]) {
      expect({ id, read: isSandboxReadTool(id) }).toEqual({ id, read: false });
    }
    expect(simulatedResult("create_contact", { a: 1 })).toEqual({ simulated: true, ok: true, tool: "create_contact", note: SIMULATED_NOTE, args: { a: 1 } });
  });

  it("unknown tool is simulated (deny by default, whatever its description says)", async () => {
    const real = jest.fn(async () => "ran");
    const tools: Record<string, any> = sandboxTools({
      list_photos: { id: "list_photos", description: "read", execute: real as never },
      shiny_new: { id: "shiny_new", description: "Read-only lookup, perfectly safe", execute: real as never },
    });
    expect(await tools.list_photos.execute({}, {})).toBe("ran");
    expect(await tools.shiny_new.execute({ x: 1 }, {})).toEqual(simulatedResult("shiny_new", { x: 1 }));
    expect(real).toHaveBeenCalledTimes(1);
  });

  it("converts every CRM tool to a strict schema", () => {
    const { factory } = services(makeFakePrisma(seed() as never));
    const defs = toolDefinitions(factory.build("ws1", { mode: "sandbox" }) as never);
    expect(defs.map((d) => d.name)).toEqual([...defs.map((d) => d.name)].sort());
    expect(defs).toHaveLength(13);
    for (const d of defs) {
      expect(d.strict).toBe(true);
      expect(d.input_schema).toMatchObject({ type: "object", additionalProperties: false });
    }
    const slots = defs.find((d) => d.name === "find_slots")!.input_schema as any;
    expect(slots.required).toEqual(expect.arrayContaining(["serviceId", "date"]));
    const appt = defs.find((d) => d.name === "list_appointments")!.input_schema as any;
    expect(appt.properties.from).toMatchObject({ type: "string", format: "date-time" });
    expect(appt.properties.limit.type).toBe("integer");
    expect(appt.properties.limit.description).toContain("maximum: 200"); // moved by the SDK's transform, still enforced by zod
    expect(appt.required).toEqual([]); // every field optional or defaulted
  });

  it("schema conversion covers the zod types in use and refuses others", () => {
    const s = toolInputSchema(
      z.object({
        a: z.string().describe("A"),
        b: z.number().int().optional(),
        c: z.enum(["x", "y"]).default("x"),
        d: z.array(z.object({ e: z.boolean() })).optional(),
        f: z.string().nullable(),
      }),
    ) as any;
    expect(s.required).toEqual(["a", "f"]);
    expect(s.properties.a).toEqual({ type: "string", description: "A" });
    expect(s.properties.c.enum).toEqual(["x", "y"]);
    expect(s.properties.d.items).toMatchObject({ type: "object", additionalProperties: false, required: ["e"] });
    expect(s.properties.f.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
    expect(() => toolInputSchema(z.object({ m: z.map(z.string(), z.string()) }))).toThrow(/unsupported/);
    expect(toolInputSchema(undefined)).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false });
  });

  it("display args keep short primitives only", () => {
    expect(displayArgs({ a: "x".repeat(300), b: 2, c: true, d: { e: 1 }, f: null, g: ["x"] })).toEqual({ a: "x".repeat(200), b: "2", c: "true" });
    expect(displayArgs(null)).toEqual({});
  });
});
