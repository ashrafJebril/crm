import { ConflictException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { WorkspacesService } from "../workspaces/workspaces.service";
import { seedWorkspaceDefaults } from "../workspaces/workspace-defaults";

jest.mock("../workspaces/workspace-defaults", () => ({
  ...jest.requireActual("../workspaces/workspace-defaults"),
  seedWorkspaceDefaults: jest.fn(),
}));
const seed = seedWorkspaceDefaults as jest.Mock;

/** In-memory Prisma whose $transaction rolls back every write when the callback throws. */
function build() {
  let users: Array<Record<string, any>> = [];
  let workspaces: Array<Record<string, any>> = [];
  let members: Array<Record<string, any>> = [];
  const txOptions: unknown[] = [];
  const handle: any = {
    user: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(users.find((u) => u.email === where.email) ?? null)),
      create: jest.fn(({ data }: any) => {
        const u = { id: `u${users.length + 1}`, isSuperAdmin: false, ...data };
        users.push(u);
        return Promise.resolve(u);
      }),
      delete: jest.fn(),
    },
    workspace: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(workspaces.find((w) => w.slug === where.slug) ?? null)),
      create: jest.fn(({ data }: any) => {
        const w = { id: `w${workspaces.length + 1}`, ...data };
        workspaces.push(w);
        return Promise.resolve(w);
      }),
    },
    workspaceMember: {
      create: jest.fn(({ data }: any) => {
        members.push(data);
        return Promise.resolve(data);
      }),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    $transaction: jest.fn(async (fn: any, opts: unknown): Promise<any> => {
      txOptions.push(opts);
      const snap = [[...users], [...workspaces], [...members]];
      try {
        return await fn(handle);
      } catch (e) {
        [users, workspaces, members] = snap as any;
        throw e;
      }
    }),
  };
  const kewySync = { userCreated: jest.fn().mockResolvedValue(undefined) };
  const ws = new WorkspacesService(handle as never, kewySync as never, {} as never, { record: jest.fn() } as never, {} as never);
  const jwt = { signAsync: jest.fn().mockResolvedValue("tok") };
  const auth = new AuthService(handle as never, jwt as never, ws, {} as never, kewySync as never, {} as never, {} as never);
  return { auth, txOptions, counts: () => ({ users: users.length, workspaces: workspaces.length, members: members.length }) };
}

const dto = { email: "a@b.co", password: "secret123", name: "Ann Bee", workspaceName: "Ann Co" };

describe("AuthService.register atomicity", () => {
  beforeEach(() => seed.mockReset().mockResolvedValue(undefined));

  it("register failure leaves no user and retry succeeds", async () => {
    const { auth, counts } = build();
    seed.mockRejectedValueOnce(new Error("Transaction already closed"));
    await expect(auth.register(dto as never)).rejects.toThrow("Transaction already closed");
    expect(counts()).toEqual({ users: 0, workspaces: 0, members: 0 });

    const res = await auth.register(dto as never);
    expect(res.token).toBe("tok");
    expect(counts()).toEqual({ users: 1, workspaces: 1, members: 1 });
    await expect(auth.register(dto as never)).rejects.toBeInstanceOf(ConflictException);
  });

  it("runs the workspace transaction with the raised timeout", async () => {
    const { auth, txOptions } = build();
    await auth.register(dto as never);
    expect(txOptions[0]).toMatchObject({ timeout: 30_000, maxWait: 10_000 });
  });
});
