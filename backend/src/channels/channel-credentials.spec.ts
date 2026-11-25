import { credentialsFor, encryptChannelSecrets } from "./channel-credentials";
import { channelErrorKey } from "./channel-errors";
import { decryptSecret, encryptSecret } from "../common/token-crypto";
import { makeFakePrisma } from "./test-prisma";

const base = {
  id: "ch",
  provider: "meta",
  workspaceId: "ws1",
  externalId: "pn-B",
  integrationId: null as string | null,
  secretsEnc: null as string | null,
};

describe("credentialsFor", () => {
  const KEY = "k".repeat(40);
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.TOKEN_ENC_KEY;
    process.env.TOKEN_ENC_KEY = KEY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TOKEN_ENC_KEY;
    else process.env.TOKEN_ENC_KEY = prev;
  });

  it("an Integration-linked channel decrypts Integration.accessToken and follows its pageId", async () => {
    const prisma = makeFakePrisma({
      integration: [{ id: "int", workspaceId: "ws1", pageId: "pn-new", accessToken: encryptSecret("TOKEN-A") }],
    });
    const c = await credentialsFor(prisma, { ...base, integrationId: "int", externalId: "pn-old" });
    expect(c).toEqual({ provider: "meta", accessToken: "TOKEN-A", externalId: "pn-new" });
  });

  it("a channel-only row decrypts secretsEnc", async () => {
    const prisma = makeFakePrisma();
    const c = await credentialsFor(prisma, {
      ...base,
      secretsEnc: encryptSecret(JSON.stringify({ accessToken: "TOKEN-B", registrationPin: "123456" })),
    });
    expect(c).toEqual({ provider: "meta", accessToken: "TOKEN-B", registrationPin: "123456", externalId: "pn-B" });
  });

  it("no secrets: only the external id", async () => {
    expect(await credentialsFor(makeFakePrisma(), base)).toEqual({ provider: "meta", externalId: "pn-B" });
  });
});

describe("encryptChannelSecrets (R5)", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("encrypts when TOKEN_ENC_KEY is set", () => {
    process.env.TOKEN_ENC_KEY = "k".repeat(40);
    const out = encryptChannelSecrets({ botToken: "SECRET" });
    expect(out.startsWith("enc:v1:")).toBe(true);
    expect(JSON.parse(decryptSecret(out))).toEqual({ botToken: "SECRET" });
  });

  it("refuses to store secrets in production without a key", () => {
    delete process.env.TOKEN_ENC_KEY;
    process.env.NODE_ENV = "production";
    let err: unknown;
    try {
      encryptChannelSecrets({ botToken: "SECRET" });
    } catch (e) {
      err = e;
    }
    expect(channelErrorKey(err)).toBe("channels.encryption_unavailable");
  });

  it("stores plaintext in dev without a key (a warning, never the secret, is logged)", () => {
    delete process.env.TOKEN_ENC_KEY;
    process.env.NODE_ENV = "development";
    const out = encryptChannelSecrets({ botToken: "SECRET" });
    expect(JSON.parse(out)).toEqual({ botToken: "SECRET" });
  });
});
