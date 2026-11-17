import { HttpException } from "@nestjs/common";
import { AuthController, REGISTER_LIMIT } from "./auth.controller";

/** SP-20 (ruling 11): the public signup page reuses register; 5 per hour per IP. */
describe("POST /auth/register limiter", () => {
  const req = (ip: string) => ({ headers: { "fly-client-ip": ip }, ip: "10.0.0.1" }) as never;
  const res = () => ({ setHeader: jest.fn() });

  it("allows 5 registrations an hour per IP, then 429 with Retry-After; other IPs are unaffected", async () => {
    const auth = { register: jest.fn(async () => ({ token: "t" })) };
    const c = new AuthController(auth as never, {} as never, {} as never, {} as never);
    for (let i = 0; i < REGISTER_LIMIT.limit; i++) await c.register({} as never, req("1.2.3.4"), res() as never);
    const r = res();
    let err: unknown;
    try {
      await c.register({} as never, req("1.2.3.4"), r as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ message: "auth.register_rate", retryAfterSeconds: expect.any(Number) });
    expect(r.setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(auth.register).toHaveBeenCalledTimes(REGISTER_LIMIT.limit);
    await c.register({} as never, req("5.6.7.8"), res() as never);
    expect(auth.register).toHaveBeenCalledTimes(REGISTER_LIMIT.limit + 1);
    expect(REGISTER_LIMIT).toEqual({ limit: 5, windowMs: 3_600_000 });
  });
});
