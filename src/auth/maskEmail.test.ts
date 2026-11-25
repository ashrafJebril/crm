import { describe, expect, it } from "vitest";
import backendSource from "../../backend/src/members/mask-email.ts?raw";
import { maskEmail } from "./maskEmail";
import maskEmailSource from "./maskEmail.ts?raw";

describe("maskEmail mirrors the backend helper", () => {
  it("first letter, masked local part, domain kept", () => {
    expect(maskEmail("nora@example.com")).toBe("n***@example.com");
    expect(maskEmail("a@x.test")).toBe("a***@x.test");
    expect(maskEmail("no-at-sign")).toBe("***");
    expect(maskEmail(" Nora@Example.com ")).toBe("N***@Example.com");
  });

  it("uses the same body as the backend", () => {
    const body = (src: string) => src.slice(src.indexOf("export function maskEmail")).replace(/\s+/g, " ").trim();
    expect(body(backendSource)).toBe(body(maskEmailSource));
  });
});

