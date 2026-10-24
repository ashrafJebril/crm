import { BadGatewayException, ServiceUnavailableException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { KewyIdentitySync, toKewyIdentity } from "./kewy-identity.sync";

const HASH = bcrypt.hashSync("secret123", 4);
const user = { id: "u1", email: "Noor@Example.com", name: "Noor", password: HASH };

const ok = (data: unknown = {}) => ({ kind: "ok" as const, status: 200, data });
const rejected = (code: string, status = 400) => ({ kind: "rejected" as const, status, code });
const unreachable = { kind: "unreachable" as const, reason: "network error: fetch failed" };

const flush = () => new Promise((r) => setImmediate(r));

function setup(mode: string) {
  process.env.AUTH_SOURCE = mode;
  const client = {
    configured: true,
    mirrorIdentity: jest.fn().mockResolvedValue(ok()),
    setPassword: jest.fn().mockResolvedValue(ok()),
    deleteIdentity: jest.fn().mockResolvedValue(ok()),
  };
  return { client, sync: new KewyIdentitySync(client as never) };
}

afterEach(() => {
  delete process.env.AUTH_SOURCE;
});

describe("toKewyIdentity", () => {
  it("maps a crm user with its bcrypt hash and a null tenant", () => {
    expect(toKewyIdentity(user)).toEqual({
      externalUserId: "u1",
      externalTenantId: null,
      email: "noor@example.com",
      name: "Noor",
      passwordHash: HASH,
    });
  });

  it("drops SSO placeholder emails, non-bcrypt hashes and the hash on request", () => {
    expect(toKewyIdentity({ ...user, email: "hjz_abc@sso.local" }).email).toBeNull();
    expect(toKewyIdentity({ ...user, password: "plaintext" })).not.toHaveProperty("passwordHash");
    expect(toKewyIdentity({ ...user, password: null })).not.toHaveProperty("passwordHash");
    expect(toKewyIdentity(user, { includeHash: false })).not.toHaveProperty("passwordHash");
  });
});

describe("KewyIdentitySync policy", () => {
  describe("local", () => {
    it("is fire-and-forget and never throws, even when Kewy fails", async () => {
      const { client, sync } = setup("local");
      client.mirrorIdentity.mockResolvedValue(rejected("INVALID_HASH"));
      client.setPassword.mockRejectedValue(new Error("boom"));
      await expect(sync.userCreated(user)).resolves.toBeUndefined();
      await expect(sync.passwordChanged(user, HASH)).resolves.toBeUndefined();
      await flush();
      expect(client.mirrorIdentity).toHaveBeenCalled();
      expect(client.setPassword).toHaveBeenCalled();
    });

    it("does nothing while Kewy is not configured", async () => {
      const { client, sync } = setup("local");
      client.configured = false;
      await sync.userCreated(user);
      sync.backfill(user);
      await flush();
      expect(client.mirrorIdentity).not.toHaveBeenCalled();
    });

    it("never runs undo", async () => {
      const { client, sync } = setup("local");
      client.mirrorIdentity.mockResolvedValue(unreachable);
      const undo = jest.fn().mockResolvedValue(undefined);
      await sync.userCreated(user, undo);
      await flush();
      expect(undo).not.toHaveBeenCalled();
    });
  });

  describe("kewy_with_fallback", () => {
    it("tolerates an unreachable Kewy on a password write", async () => {
      const { client, sync } = setup("kewy_with_fallback");
      client.setPassword.mockResolvedValue(unreachable);
      await expect(sync.passwordChanged(user, HASH)).resolves.toBeUndefined();
    });

    it("fails a password write Kewy rejects, and runs undo", async () => {
      const { client, sync } = setup("kewy_with_fallback");
      client.mirrorIdentity.mockResolvedValue(rejected("INVALID_HASH"));
      const undo = jest.fn().mockResolvedValue(undefined);
      await expect(sync.userCreated(user, undo)).rejects.toBeInstanceOf(BadGatewayException);
      expect(undo).toHaveBeenCalledTimes(1);
    });

    it("keeps profile writes best-effort", async () => {
      const { client, sync } = setup("kewy_with_fallback");
      client.mirrorIdentity.mockResolvedValue(rejected("INVALID_BODY"));
      client.deleteIdentity.mockResolvedValue(unreachable);
      await expect(sync.profileChanged(user)).resolves.toBeUndefined();
      await expect(sync.userDeleted("u1")).resolves.toBeUndefined();
      await expect(sync.userCreated({ ...user, password: null })).resolves.toBeUndefined();
    });
  });

  describe("kewy", () => {
    it("fails a password write when Kewy is unreachable", async () => {
      const { client, sync } = setup("kewy");
      client.setPassword.mockResolvedValue(unreachable);
      await expect(sync.passwordChanged(user, HASH)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it("treats a thrown client error as unreachable", async () => {
      const { client, sync } = setup("kewy");
      client.setPassword.mockRejectedValue(new Error("socket hang up"));
      await expect(sync.passwordReset(user, HASH)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it("succeeds when Kewy accepts the write", async () => {
      const { sync } = setup("kewy");
      await expect(sync.userCreated(user)).resolves.toBeUndefined();
    });
  });

  describe("operations", () => {
    it("passwordChanged sets the account password by hash", async () => {
      const { client, sync } = setup("kewy");
      await sync.passwordChanged(user, HASH);
      expect(client.setPassword).toHaveBeenCalledWith("u1", { passwordHash: HASH, scope: "account" });
      expect(client.mirrorIdentity).not.toHaveBeenCalled();
    });

    it("passwordChanged mirrors an unknown identity, then sets the password", async () => {
      const { client, sync } = setup("kewy");
      client.setPassword
        .mockResolvedValueOnce(rejected("IDENTITY_NOT_FOUND", 404))
        .mockResolvedValueOnce(ok({ accountId: "a1" }));
      await sync.passwordChanged(user, HASH);
      expect(client.mirrorIdentity).toHaveBeenCalledWith(
        expect.objectContaining({ externalUserId: "u1", passwordHash: HASH }),
      );
      expect(client.setPassword).toHaveBeenCalledTimes(2);
    });

    it("passwordReset (admin-initiated) is scoped to crm, never the Kewy account", async () => {
      const { client, sync } = setup("kewy");
      const newHash = bcrypt.hashSync("reset-pw", 4);
      await sync.passwordReset(user, newHash);
      expect(client.setPassword).toHaveBeenCalledWith("u1", { passwordHash: newHash, scope: "product" });
      expect(client.mirrorIdentity).not.toHaveBeenCalled();
    });

    it("profileChanged sends no hash; userDeleted deletes the identity", async () => {
      const { client, sync } = setup("kewy");
      await sync.profileChanged(user);
      await sync.userDeleted("u1");
      await flush();
      expect(client.mirrorIdentity.mock.calls[0][0]).not.toHaveProperty("passwordHash");
      expect(client.deleteIdentity).toHaveBeenCalledWith("u1");
    });
  });
});
