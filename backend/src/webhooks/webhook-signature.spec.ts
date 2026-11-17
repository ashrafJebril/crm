import { createHmac } from "crypto";
import { newWebhookSecret, sign, verify } from "./webhook-signature";

describe("webhook signatures", () => {
  const body = '{"id":"evt_1","type":"ping"}';
  const t = 1_763_460_000;

  it("t=<unix>,v1=<hex HMAC-SHA256(secret, t.body)> per secret", () => {
    const s = newWebhookSecret();
    expect(s).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const h = sign([s], t, body);
    expect(h).toBe(`t=${t},v1=${createHmac("sha256", s).update(`${t}.${body}`).digest("hex")}`);
    expect(sign(["a", "b"], t, body).split(",")).toHaveLength(3);
    expect(() => sign([], t, body)).toThrow();
  });

  it("verify: right secret within the window only; any v1 may match", () => {
    const [a, b] = [newWebhookSecret(), newWebhookSecret()];
    const h = sign([a, b], t, body);
    expect(verify(a, h, body, t)).toBe(true);
    expect(verify(b, h, body, t + 299)).toBe(true);
    expect(verify(a, h, body, t + 301)).toBe(false); // replay window
    expect(verify(a, h, body, t - 301)).toBe(false);
    expect(verify("whsec_other", h, body, t)).toBe(false);
    expect(verify(a, h, `${body} `, t)).toBe(false);
    for (const bad of [null, "", "v1=abc", `t=${t}`, `t=x,v1=${"0".repeat(64)}`]) expect(verify(a, bad, body, t)).toBe(false);
  });
});
