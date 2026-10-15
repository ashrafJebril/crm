import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import * as bcrypt from "bcryptjs";
import { AdminService } from "./admin.service";
import { ProvisionClientDto } from "./admin.dto";

jest.mock("../workspaces/workspace-defaults", () => ({
  seedWorkspaceDefaults: jest.fn().mockResolvedValue(undefined),
}));

// A real bcryptjs cost-10 hash of "kewy-secret".
const KEWY_HASH = bcrypt.hashSync("kewy-secret", 10);

const base = {
  workspaceName: "Salon Noor",
  ownerEmail: "owner@example.com",
  ownerName: "Noor Owner",
};

describe("ProvisionClientDto ownerPasswordHash validation", () => {
  const check = (o: Record<string, unknown>) =>
    validate(plainToInstance(ProvisionClientDto, o), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it("accepts a bcrypt hash ($2a$, $2b$, $2y$)", async () => {
    for (const prefix of ["$2a$", "$2b$", "$2y$"]) {
      const errs = await check({
        ...base,
        ownerPasswordHash: KEWY_HASH.replace(/^\$2[aby]\$/, prefix),
      });
      expect(errs).toEqual([]);
    }
  });

  it.each([
    ["plaintext", "kewy-secret"],
    ["wrong prefix", KEWY_HASH.replace(/^\$2a\$/, "$2x$")],
    ["one-digit cost", KEWY_HASH.replace("$10$", "$9$")],
    ["truncated", KEWY_HASH.slice(0, -1)],
    ["too long", KEWY_HASH + "a"],
    ["bad char", KEWY_HASH.slice(0, -1) + "!"],
  ])("rejects an invalid hash (%s)", async (_label, hash) => {
    const errs = await check({ ...base, ownerPasswordHash: hash });
    expect(errs.map((e) => e.property)).toContain("ownerPasswordHash");
  });

  it("rejects ownerPassword and ownerPasswordHash together", async () => {
    const errs = await check({
      ...base,
      ownerPassword: "secret123",
      ownerPasswordHash: KEWY_HASH,
    });
    const err = errs.find((e) => e.property === "ownerPasswordHash");
    expect(err?.constraints).toHaveProperty("notWith");
  });

  it("still accepts ownerPassword alone", async () => {
    expect(await check({ ...base, ownerPassword: "secret123" })).toEqual([]);
  });
});

describe("AdminService.provisionClient password handling", () => {
  function setup(existing: Record<string, unknown> | null = null) {
    const tx = {
      user: {
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: "u1", ...data }),
        ),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({ ...existing, ...data }),
        ),
      },
      workspace: {
        create: jest.fn().mockResolvedValue({ id: "ws1", name: "Salon Noor", slug: "salon-noor" }),
      },
      workspaceMember: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      raw: {
        workspace: { findUnique: jest.fn().mockResolvedValue(null) },
        workspaceMember: { findFirst: jest.fn() },
        user: { findFirst: jest.fn().mockResolvedValue(existing) },
        $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
      },
    };
    const svc = new AdminService(prisma as never, {} as never);
    return { svc, tx };
  }

  it("stores ownerPasswordHash verbatim (no re-hash)", async () => {
    const { svc, tx } = setup();
    await svc.provisionClient({ ...base, ownerPasswordHash: KEWY_HASH } as ProvisionClientDto);
    const stored = tx.user.create.mock.calls[0][0].data.password;
    expect(stored).toBe(KEWY_HASH);
    expect(bcrypt.compareSync("kewy-secret", stored)).toBe(true);
  });

  it("hashes a plaintext ownerPassword as before", async () => {
    const { svc, tx } = setup();
    await svc.provisionClient({ ...base, ownerPassword: "secret123" } as ProvisionClientDto);
    const stored = tx.user.create.mock.calls[0][0].data.password;
    expect(stored).not.toBe("secret123");
    expect(bcrypt.compareSync("secret123", stored)).toBe(true);
  });

  it("stores no password when neither is given", async () => {
    const { svc, tx } = setup();
    await svc.provisionClient({ ...base } as ProvisionClientDto);
    expect(tx.user.create.mock.calls[0][0].data.password).toBeNull();
  });

  it("rejects both ownerPassword and ownerPasswordHash with a 400", async () => {
    const { svc } = setup();
    await expect(
      svc.provisionClient({
        ...base,
        ownerPassword: "secret123",
        ownerPasswordHash: KEWY_HASH,
      } as ProvisionClientDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("never overwrites an existing user's password", async () => {
    const { svc, tx } = setup({ id: "u1", email: base.ownerEmail, password: "$2a$10$existing", kewyAccountId: null });
    await svc.provisionClient({ ...base, ownerPasswordHash: KEWY_HASH } as ProvisionClientDto);
    expect(tx.user.update.mock.calls[0][0].data).not.toHaveProperty("password");
  });

  it("fills in a missing password on an existing user from the hash", async () => {
    const { svc, tx } = setup({ id: "u1", email: base.ownerEmail, password: null, kewyAccountId: null });
    await svc.provisionClient({ ...base, ownerPasswordHash: KEWY_HASH } as ProvisionClientDto);
    expect(tx.user.update.mock.calls[0][0].data.password).toBe(KEWY_HASH);
  });
});
