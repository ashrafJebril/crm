import { Logger, ServiceUnavailableException } from "@nestjs/common";
import { DisabledEmailSender } from "./disabled-email-sender";
import { emailProvider } from "./email-sender";
import { createEmailSender } from "./email.module";
import { FakeEmailSender } from "./fake-email-sender";
import { ResendEmailSender } from "./resend-email-sender";

const msg = { to: "a@example.com", subject: "S", html: "<p>secret-link</p>", text: "secret-link", kind: "invite" };

describe("email port (SP-26)", () => {
  it("EMAIL_PROVIDER defaults to off; only 'resend' turns it on", () => {
    expect(emailProvider({})).toBe("off");
    expect(emailProvider({ EMAIL_PROVIDER: "ses" })).toBe("off");
    expect(emailProvider({ EMAIL_PROVIDER: " Resend " })).toBe("resend");
  });

  it("resend without a key or sender falls back to off, without logging secrets", () => {
    const warn = jest.fn();
    const logger = { warn } as unknown as Logger;
    expect(createEmailSender({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_k" }, logger)).toBeInstanceOf(DisabledEmailSender);
    expect(warn.mock.calls.join(" ")).not.toContain("re_k");
    expect(createEmailSender({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_k", EMAIL_FROM: "x@y" }, logger)).toBeInstanceOf(
      ResendEmailSender,
    );
    expect(createEmailSender({}, logger).enabled).toBe(false);
  });

  it("the disabled sender refuses with 503 email.not_configured", async () => {
    const err = await new DisabledEmailSender().send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ statusCode: 503, message: "email.not_configured" });
  });

  it("resend posts one message to the configured base (stubbed fetch) and logs no body or key", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: "em_1" }) });
    const logs: string[] = [];
    const s = new ResendEmailSender({ apiKey: "re_secret", from: "tkana <no-reply@x.test>", apiBase: "http://127.0.0.1:4249/", fetchImpl });
    (s as unknown as { logger: Logger }).logger = { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) } as never;
    expect(await s.send(msg)).toEqual({ id: "em_1" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4249/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_secret");
    expect(JSON.parse(init.body)).toMatchObject({ from: "tkana <no-reply@x.test>", to: ["a@example.com"], subject: "S" });
    expect(logs.join("\n")).not.toMatch(/secret-link|re_secret|a@example\.com/);
  });

  it("resend failure throws without echoing the response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 422, json: async () => ({ message: "secret-link" }) });
    const s = new ResendEmailSender({ apiKey: "k", from: "f@x", fetchImpl });
    (s as unknown as { logger: Logger }).logger = { log: jest.fn(), warn: jest.fn() } as never;
    const err = await s.send(msg).catch((e) => e);
    expect(String(err.message)).toContain("422");
    expect(String(err.message)).not.toContain("secret-link");
  });

  it("the fake records messages and can fail", async () => {
    const f = new FakeEmailSender();
    await f.send(msg);
    expect(f.lastTo("A@example.com")?.subject).toBe("S");
    f.fail = new Error("down");
    await expect(f.send(msg)).rejects.toThrow("down");
  });
});
