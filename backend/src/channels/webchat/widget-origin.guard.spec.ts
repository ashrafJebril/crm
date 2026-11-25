import { apiOrigins, clientIp, primaryApiOrigin } from "./widget-origin.guard";

describe("widget origin helpers", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env.PUBLIC_BASE_URL = env.PUBLIC_BASE_URL;
    process.env.NODE_ENV = env.NODE_ENV;
  });

  it("the API origin is PUBLIC_BASE_URL first, then the addressed Host", () => {
    process.env.PUBLIC_BASE_URL = "https://api.example.com/";
    expect(apiOrigins({ headers: { host: "crm.fly.dev", "x-forwarded-proto": "https" } })).toEqual([
      "https://api.example.com",
      "https://crm.fly.dev",
    ]);
    expect(primaryApiOrigin({ headers: {} })).toBe("https://api.example.com");
  });

  it("dev without PUBLIC_BASE_URL accepts the http Host; production only https", () => {
    process.env.PUBLIC_BASE_URL = "";
    process.env.NODE_ENV = "development";
    expect(apiOrigins({ headers: { host: "localhost:3001" } })).toEqual(["http://localhost:3001", "https://localhost:3001"]);
    process.env.NODE_ENV = "production";
    expect(apiOrigins({ headers: { host: "crm.fly.dev" } })).toEqual(["https://crm.fly.dev"]);
  });

  it("a malformed Host never becomes an origin (no CSP or header injection)", () => {
    process.env.PUBLIC_BASE_URL = "";
    expect(apiOrigins({ headers: { host: "evil.example; script-src *" } })).toEqual([]);
    expect(apiOrigins({ headers: { host: "a/b" } })).toEqual([]);
    expect(primaryApiOrigin({ headers: {} })).toBe("http://localhost:3001");
  });

  it("client IP is Fly-Client-IP, else the socket address", () => {
    expect(clientIp({ headers: { "fly-client-ip": " 1.2.3.4 " }, ip: "10.0.0.1" })).toBe("1.2.3.4");
    expect(clientIp({ headers: {}, ip: "10.0.0.1" })).toBe("10.0.0.1");
    expect(clientIp({ headers: {} })).toBe("unknown");
  });
});
