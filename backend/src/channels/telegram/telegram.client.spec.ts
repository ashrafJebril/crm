import { TelegramApiError, TelegramClient } from "./telegram.client";

const TOKEN = "123456:AAH-secret_token_value_xyz";

function respond(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) } as never;
}

describe("TelegramClient", () => {
  let fetchMock: jest.SpyInstance;
  const client = new TelegramClient();

  beforeEach(() => {
    fetchMock = jest.spyOn(global, "fetch");
  });
  afterEach(() => fetchMock.mockRestore());

  it("getMe returns the bot", async () => {
    fetchMock.mockResolvedValue(respond({ ok: true, result: { id: 42, is_bot: true, first_name: "Shop", username: "shop_bot" } }));
    await expect(client.getMe(TOKEN)).resolves.toMatchObject({ id: 42, username: "shop_bot" });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
  });

  it("setWebhook sends url, secret_token and allowed_updates [message]", async () => {
    fetchMock.mockResolvedValue(respond({ ok: true, result: true }));
    await client.setWebhook(TOKEN, { url: "https://api.example.com/api/webhooks/telegram/c1", secretToken: "s".repeat(64) });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/setWebhook`);
    expect(JSON.parse(init.body)).toEqual({
      url: "https://api.example.com/api/webhooks/telegram/c1",
      secret_token: "s".repeat(64),
      allowed_updates: ["message"],
    });
  });

  it("sendMessage posts chat_id and text and returns message_id", async () => {
    fetchMock.mockResolvedValue(respond({ ok: true, result: { message_id: 77 } }));
    await expect(client.sendMessage(TOKEN, "555", "hi")).resolves.toEqual({ message_id: 77 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ chat_id: "555", text: "hi" });
  });

  it("deleteWebhook calls the method", async () => {
    fetchMock.mockResolvedValue(respond({ ok: true, result: true }));
    await client.deleteWebhook(TOKEN);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${TOKEN}/deleteWebhook`);
  });

  it("getFile + download fetch the file path under /file/bot<token>/", async () => {
    fetchMock
      .mockResolvedValueOnce(respond({ ok: true, result: { file_id: "f", file_path: "photos/a.jpg", file_size: 3 } }))
      .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as never);
    const f = await client.getFile(TOKEN, "f");
    const buf = await client.downloadFile(TOKEN, f.file_path!);
    expect([...buf]).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls[1][0]).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/a.jpg`);
  });

  it("an API error is a TelegramApiError with the token masked", async () => {
    fetchMock.mockResolvedValue(respond({ ok: false, error_code: 401, description: `Unauthorized for ${TOKEN}` }, 401));
    const err = await client.getMe(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.errorCode).toBe(401);
    expect(err.message).toContain("Telegram getMe failed");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("AAH-secret");
  });

  it("a network error never carries the token or the URL's secret", async () => {
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`));
    const err = await client.getMe(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err.message).not.toContain("AAH-secret");
    expect(String(err.stack)).not.toContain("AAH-secret");
  });

  it("a non-JSON failure reports the HTTP status", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error("bad json"); } } as never);
    const err = await client.deleteWebhook(TOKEN).catch((e) => e);
    expect(err.message).toBe("Telegram deleteWebhook failed: HTTP 502");
  });

  it("refuses a malformed token before any request (no path injection)", async () => {
    const err = await client.getMe("123/../../x").catch((e) => e);
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("SP-22: the Telegram API base (Task 4 stubs it)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { telegramApiBase, TELEGRAM_DEFAULT_API, TelegramClient } = require("./telegram.client");

  it("telegram base url defaults to the real api and accepts only https or loopback", () => {
    expect(telegramApiBase({})).toBe(TELEGRAM_DEFAULT_API);
    expect(TELEGRAM_DEFAULT_API).toBe("https://api.telegram.org");
    expect(telegramApiBase({ TELEGRAM_API_BASE_URL: "http://127.0.0.1:4260/" })).toBe("http://127.0.0.1:4260");
    expect(telegramApiBase({ TELEGRAM_API_BASE_URL: "http://localhost:4260" })).toBe("http://localhost:4260");
    expect(telegramApiBase({ TELEGRAM_API_BASE_URL: "https://tg-proxy.example.com/api/" })).toBe("https://tg-proxy.example.com/api");
    for (const bad of ["http://evil.example.com", "ftp://127.0.0.1", "not a url", "https://u:p@x.example.com", "http://127.0.0.2:1"]) {
      expect({ bad, base: telegramApiBase({ TELEGRAM_API_BASE_URL: bad }) }).toEqual({ bad, base: TELEGRAM_DEFAULT_API });
    }
  });

  it("sendMessage goes to the configured base, plain text (no parse_mode)", async () => {
    const prev = process.env.TELEGRAM_API_BASE_URL;
    process.env.TELEGRAM_API_BASE_URL = "http://127.0.0.1:4260";
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    try {
      const token = "123456:ABCDEFGHIJKLMNOPQRSTuvwxyz";
      await new TelegramClient().sendMessage(token, "42", "<b>hi</b> *there*");
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`http://127.0.0.1:4260/bot${token}/sendMessage`);
      expect(JSON.parse(String(init.body))).toEqual({ chat_id: "42", text: "<b>hi</b> *there*" });
    } finally {
      fetchSpy.mockRestore();
      if (prev === undefined) delete process.env.TELEGRAM_API_BASE_URL;
      else process.env.TELEGRAM_API_BASE_URL = prev;
    }
  });
});
