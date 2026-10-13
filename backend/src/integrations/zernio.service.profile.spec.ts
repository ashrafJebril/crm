import { HttpException } from "@nestjs/common";
import { ZernioService } from "./zernio.service";

const WS_ID = "cmabc123def456xyz789";

function build(zernioProfileId: string | null = null, name = "Tiremall") {
  const prisma: any = {
    workspace: {
      findUnique: jest.fn().mockResolvedValue({ id: WS_ID, name, zernioProfileId }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const client: any = { createProfile: jest.fn().mockResolvedValue({ id: "prof-1" }) };
  const svc = new ZernioService(
    prisma,
    {} as never,
    {} as never,
    client,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, prisma, client };
}

const conflict = () => new HttpException("A profile with this name already exists", 409);

describe("ZernioService.ensureProfile", () => {
  afterEach(() => jest.restoreAllMocks());

  it("creates the profile with a name including the workspace id suffix", async () => {
    const { svc, client, prisma } = build();
    await expect(svc.ensureProfile(WS_ID)).resolves.toBe("prof-1");
    expect(client.createProfile).toHaveBeenCalledWith(
      `Tiremall · ${WS_ID.slice(-6)}`,
      `tkana workspace ${WS_ID}`,
    );
    expect(prisma.workspace.updateMany).toHaveBeenCalledWith({
      where: { id: WS_ID, zernioProfileId: null },
      data: { zernioProfileId: "prof-1" },
    });
  });

  it("keeps the name within 60 chars and falls back to Workspace", async () => {
    const long = build(null, "x".repeat(200));
    await long.svc.ensureProfile(WS_ID);
    expect(long.client.createProfile.mock.calls[0][0].length).toBeLessThanOrEqual(60);
    expect(long.client.createProfile.mock.calls[0][0]).toMatch(/ · [^ ]{6}$/);
    const empty = build(null, "  ");
    await empty.svc.ensureProfile(WS_ID);
    expect(empty.client.createProfile.mock.calls[0][0]).toBe(`Workspace · ${WS_ID.slice(-6)}`);
  });

  it("keeps the retry name within 60 chars for very long workspace names", async () => {
    const { svc, client } = build(null, "y".repeat(200));
    client.createProfile.mockRejectedValueOnce(conflict());
    await svc.ensureProfile(WS_ID);
    const [first, second] = client.createProfile.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(first.length).toBeLessThanOrEqual(60);
    expect(second.length).toBeLessThanOrEqual(60);
    expect(second).toMatch(/ · [0-9a-f]{6}$/);
  });

  it("returns an existing profile id without calling Zernio", async () => {
    const { svc, client, prisma } = build("existing");
    await expect(svc.ensureProfile(WS_ID)).resolves.toBe("existing");
    expect(client.createProfile).not.toHaveBeenCalled();
    expect(prisma.workspace.updateMany).not.toHaveBeenCalled();
  });

  it("retries once with a random suffix on an 'already exists' error", async () => {
    const { svc, client } = build();
    client.createProfile.mockRejectedValueOnce(conflict());
    await expect(svc.ensureProfile(WS_ID)).resolves.toBe("prof-1");
    expect(client.createProfile).toHaveBeenCalledTimes(2);
    const [first, second] = client.createProfile.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(second).not.toBe(first);
    expect(second.startsWith(`${first} · `)).toBe(true);
    expect(second).toMatch(/ · [0-9a-f]{6}$/);
    expect(first.length).toBeLessThanOrEqual(60);
    expect(second.length).toBeLessThanOrEqual(60);
  });

  it("propagates a second 'already exists' error", async () => {
    const { svc, client, prisma } = build();
    client.createProfile.mockRejectedValue(conflict());
    await expect(svc.ensureProfile(WS_ID)).rejects.toThrow(/already exists/);
    expect(client.createProfile).toHaveBeenCalledTimes(2);
    expect(prisma.workspace.updateMany).not.toHaveBeenCalled();
  });

  it("rethrows other errors without retrying", async () => {
    const { svc, client } = build();
    const err = new HttpException("boom", 502);
    client.createProfile.mockRejectedValue(err);
    await expect(svc.ensureProfile(WS_ID)).rejects.toBe(err);
    expect(client.createProfile).toHaveBeenCalledTimes(1);
  });

  it("returns the stored id when another request won the race", async () => {
    const { svc, prisma } = build();
    prisma.workspace.updateMany.mockResolvedValue({ count: 0 });
    prisma.workspace.findUnique
      .mockResolvedValueOnce({ id: WS_ID, name: "Tiremall", zernioProfileId: null })
      .mockResolvedValueOnce({ zernioProfileId: "winner" });
    await expect(svc.ensureProfile(WS_ID)).resolves.toBe("winner");
  });
});
