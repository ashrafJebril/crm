import { McpToolsFactory } from "./mcp-tools.factory";
import { MediaService } from "../media/media.service";
import { makeFakePrisma } from "../channels/test-prisma";

/**
 * SP-17 acceptance (roadmap): the agent's `list_photos` tool, through the real
 * McpToolsFactory and the real MediaService on the in-memory Prisma double.
 * Storage is mocked: every row is a Spaces row whose signed URL is
 * https://cdn.test/<id> (resolveExternalUrl maps storedPath "ws/<id>").
 */
const MB = 1024 * 1024;
const t0 = Date.UTC(2026, 10, 1);
const at = (min: number) => new Date(t0 + min * 60_000);

function photo(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspaceId: "wsA",
    fileName: `${id}.jpg`,
    mimeType: "image/jpeg",
    sizeBytes: MB,
    storedPath: `wsA/${id}`,
    storageKind: "spaces",
    uploadedById: "staff",
    publicToken: null,
    publicTokenExpiresAt: null,
    title: `Menu ${id}`,
    alt: `menu photo ${id}`,
    tags: ["menu"],
    useWhen: "when they ask for the menu",
    approvedForAgent: false,
    createdAt: at(1),
    ...over,
  };
}

function setup() {
  const prisma = makeFakePrisma({
    media: [
      photo("ok-jpg", { approvedForAgent: true, createdAt: at(1) }),
      photo("ok-png", { approvedForAgent: true, mimeType: "image/png", fileName: "ok.png", createdAt: at(2) }),
      photo("unapproved", { title: "Secret breakfast offer", createdAt: at(3) }),
      photo("hidden", { createdAt: at(4) }),
      // Written straight into the double, bypassing the PATCH rules.
      photo("pdf", { approvedForAgent: true, mimeType: "application/pdf", createdAt: at(5) }),
      photo("webp", { approvedForAgent: true, mimeType: "image/webp", createdAt: at(6) }),
      photo("big", { approvedForAgent: true, sizeBytes: 6 * MB, createdAt: at(7) }),
      photo("foreign", { workspaceId: "wsB", storedPath: "wsB/foreign", approvedForAgent: true, createdAt: at(8) }),
    ],
  });
  const storage = {
    kind: "spaces",
    getSignedUrl: jest.fn(async (key: string) => `https://cdn.test/${key.split("/").pop()}`),
    put: jest.fn(),
    delete: jest.fn(),
  };
  const media = new MediaService(prisma, storage as never);
  const factory = new McpToolsFactory({} as never, {} as never, media);
  const listPhotos = async (input: Record<string, unknown>) => {
    const out: any = await factory.build("wsA").list_photos.execute!(input as never, {} as never);
    return out;
  };
  return { prisma, storage, media, listPhotos };
}

const APPROVED = new Set(["ok-jpg", "ok-png"]);
const idsOf = (out: any) => (out.photos as { id: string }[]).map((p) => p.id);

describe("list_photos", () => {
  it("agent tool never returns unapproved media", async () => {
    const { media, listPhotos, storage } = setup();
    // `hidden` was approved, then switched off through the PATCH path.
    await media.update("wsA", "hidden", { approvedForAgent: true }, undefined);
    await media.update("wsA", "hidden", { approvedForAgent: false }, undefined);

    // Exactly the approved photos, newest first.
    const all = await listPhotos({});
    expect(idsOf(all)).toEqual(["ok-png", "ok-jpg"]);
    expect(all.photos[0].url).toBe("https://cdn.test/ok-png");
    expect(storage.getSignedUrl).toHaveBeenCalledWith("wsA/ok-png", 86400);

    // The unapproved row's own title finds nothing.
    expect(idsOf(await listPhotos({ query: "Secret breakfast offer" }))).toEqual([]);

    // Queries and tags that match every row's text never leave the approved set.
    for (const input of [
      { query: "menu" },
      { query: "MENU photo" },
      { query: "jpg" },
      { query: "unapproved" },
      { query: "hidden" },
      { query: "pdf" },
      { query: "webp" },
      { query: "big" },
      { query: "foreign" },
      { query: "when they ask" },
      { tag: "menu" },
      { tag: " MENU " },
      { tag: "menu", query: "menu" },
      { query: "menu", limit: 10 },
    ]) {
      const ids = idsOf(await listPhotos(input));
      expect({ input, leaked: ids.filter((id) => !APPROVED.has(id)) }).toEqual({ input, leaked: [] });
    }
    expect(idsOf(await listPhotos({ query: "menu", limit: 10 }))).toEqual(["ok-png", "ok-jpg"]);

    // Hiding takes effect on the next call.
    await media.update("wsA", "ok-jpg", { approvedForAgent: false }, undefined);
    expect(idsOf(await listPhotos({}))).toEqual(["ok-png"]);

    // Only the agent-facing keys: no storage path, token, uploader or size.
    const [p] = (await listPhotos({})).photos;
    expect(Object.keys(p).sort()).toEqual(["alt", "id", "mimeType", "tags", "title", "url", "useWhen"]);
    expect(p).toEqual({
      id: "ok-png",
      title: "Menu ok-png",
      alt: "menu photo ok-png",
      tags: ["menu"],
      useWhen: "when they ask for the menu",
      mimeType: "image/png",
      url: "https://cdn.test/ok-png",
    });
  });

  it("another workspace's approved photo never appears", async () => {
    const { listPhotos } = setup();
    for (const input of [{}, { query: "foreign" }, { tag: "menu" }]) {
      expect(idsOf(await listPhotos(input))).not.toContain("foreign");
    }
  });

  it("limit: default 5, above 10 is refused by the schema", async () => {
    const { prisma, listPhotos } = setup();
    for (let i = 0; i < 12; i++) {
      prisma.db.media.push(photo(`extra${i}`, { approvedForAgent: true, createdAt: at(100 + i) }));
    }
    expect(idsOf(await listPhotos({}))).toHaveLength(5);
    expect(idsOf(await listPhotos({ limit: 10 }))).toHaveLength(10);
    const refused = await listPhotos({ limit: 11 });
    expect(refused?.photos).toBeUndefined();
    expect(refused).toMatchObject({ error: true });
  });

  it("title falls back to the file name for older untitled data", async () => {
    const { prisma, listPhotos } = setup();
    prisma.db.media.push(photo("untitled", { title: null, fileName: "IMG_1.jpg", approvedForAgent: true, createdAt: at(50) }));
    expect((await listPhotos({ limit: 1 })).photos[0]).toMatchObject({ id: "untitled", title: "IMG_1.jpg" });
  });
});
