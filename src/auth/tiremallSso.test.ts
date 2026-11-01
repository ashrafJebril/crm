import { describe, expect, it } from "vitest";
import { exchangeTiremallSso } from "./tiremallSso";

const fetchOf = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("exchangeTiremallSso", () => {
  it("returns the access token on success", async () => {
    expect(await exchangeTiremallSso("t", "/api", fetchOf(200, { accessToken: "a" }))).toEqual({
      kind: "ok",
      accessToken: "a",
    });
  });
  it("reports a payment-locked workspace distinctly", async () => {
    const r = await exchangeTiremallSso(
      "t",
      "/api",
      fetchOf(403, { statusCode: 403, code: "PAYMENT_OVERDUE", message: "x" }),
    );
    expect(r).toEqual({ kind: "payment_overdue" });
  });
  it("treats other failures and network errors as failed", async () => {
    expect(await exchangeTiremallSso("t", "/api", fetchOf(403, { message: "suspended" }))).toEqual({ kind: "failed" });
    const boom = (async () => { throw new Error("net"); }) as unknown as typeof fetch;
    expect(await exchangeTiremallSso("t", "/api", boom)).toEqual({ kind: "failed" });
  });
});
