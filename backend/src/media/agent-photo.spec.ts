import { agentImageDecision, parseOwnMediaUrl } from "./agent-photo";
import { makeFakePrisma } from "../channels/test-prisma";

const ENV = {
  PUBLIC_BASE_URL: "https://crm.example.test/",
  APP_BASE_URL: "https://app.example.test",
  DO_SPACES_BUCKET: "aram",
  DO_SPACES_ENDPOINT: "https://fra1.digitaloceanspaces.com",
  DO_SPACES_CDN_ENDPOINT: "https://aram.fra1.cdn.digitaloceanspaces.com",
};

describe("parse own media url recognises public-token and storage urls", () => {
  it("public-token links on either base url, query ignored", () => {
    expect(parseOwnMediaUrl("https://crm.example.test/api/media/m1/public?token=abc", ENV)).toEqual({ id: "m1" });
    expect(parseOwnMediaUrl("https://app.example.test/api/media/m2/public?token=x&y=1", ENV)).toEqual({ id: "m2" });
    // Base with a path prefix.
    expect(
      parseOwnMediaUrl("https://h.test/crm/api/media/m3/public?token=t", { PUBLIC_BASE_URL: "https://h.test/crm" }),
    ).toEqual({ id: "m3" });
    // No base configured: the same default resolveExternalUrl uses.
    expect(parseOwnMediaUrl("http://localhost:3001/api/media/m4/public?token=t", {})).toEqual({ id: "m4" });
  });

  it("the public-token path is ours on any host, scheme, case and form (fail closed)", () => {
    for (const url of [
      "https://evil.test/api/media/m1/public?token=abc", // another hostname
      "http://crm.example.test/api/media/m1/public?token=abc", // http vs https
      "https://crm.example.test./api/media/m1/public?token=abc", // trailing-dot host
      "https://CRM.example.test:443/API/Media/m1/PUBLIC?token=abc", // uppercase path, explicit port
      "https://crm.example.test/api/media/m1/public/?token=abc", // trailing slash
      "https://crm.example.test/%61pi/media/%6D1/public?token=abc", // encoded path
      "https://alias.test/prefix/api/media/m1/public", // a base path prefix
    ]) {
      expect({ url, ref: parseOwnMediaUrl(url, ENV) }).toEqual({ url, ref: { id: "m1" } });
    }
    expect(parseOwnMediaUrl("https://crm.example.test/api/media/m1/file", ENV)).toBeNull();
    expect(parseOwnMediaUrl("https://crm.example.test/api/media//public", ENV)).toBeNull();
  });

  it("Spaces virtual-hosted, path-style and CDN urls give the object-key candidates", () => {
    const key = { storedPathCandidates: ["ws1/abc.jpg"] };
    expect(parseOwnMediaUrl("https://aram.fra1.digitaloceanspaces.com/ws1/abc.jpg?X-Amz-Signature=s", ENV)).toEqual(key);
    expect(parseOwnMediaUrl("https://aram.fra1.cdn.digitaloceanspaces.com/ws1/abc.jpg?X-Amz-Expires=1", ENV)).toEqual(key);
    expect(parseOwnMediaUrl("https://fra1.digitaloceanspaces.com/aram/ws1/abc.jpg?X-Amz-Date=1", ENV)).toEqual(key);
    // Host normalised: case, trailing dot, port and scheme do not matter.
    expect(parseOwnMediaUrl("http://ARAM.fra1.digitaloceanspaces.com.:8443/ws1/abc.jpg", ENV)).toEqual(key);
    expect(parseOwnMediaUrl("https://FRA1.digitaloceanspaces.com./Aram/ws1/abc.jpg", ENV)).toEqual(key);
    // Encoded key.
    expect(parseOwnMediaUrl("https://aram.fra1.digitaloceanspaces.com/ws1/%61bc.jpg", ENV)).toEqual(key);
    // The bucket's DO CDN host is derived from the endpoint when DO_SPACES_CDN_ENDPOINT is unset.
    const noCdn = { ...ENV, DO_SPACES_CDN_ENDPOINT: undefined };
    expect(parseOwnMediaUrl("https://aram.fra1.cdn.digitaloceanspaces.com/ws1/abc.jpg?X-Amz-Expires=1", noCdn)).toEqual(key);
    expect(parseOwnMediaUrl("https://aram.fra1.cdn.digitaloceanspaces.com./ws1/abc.jpg", noCdn)).toEqual(key);
    // A configured custom CDN host still counts, with the derived one.
    const custom = { ...ENV, DO_SPACES_CDN_ENDPOINT: "https://media.example.test" };
    expect(parseOwnMediaUrl("https://MEDIA.example.test./ws1/abc.jpg", custom)).toEqual(key);
    expect(parseOwnMediaUrl("https://aram.fra1.cdn.digitaloceanspaces.com/ws1/abc.jpg", custom)).toEqual(key);
    expect(parseOwnMediaUrl("https://aram.fra1.digitaloceanspaces.com/p/ws1/a%20b.png", ENV)).toEqual({
      storedPathCandidates: ["p/ws1/a b.png", "ws1/a b.png"],
    });
  });

  it("another bucket, another host, non-http and malformed urls are not ours", () => {
    expect(parseOwnMediaUrl("https://fra1.digitaloceanspaces.com/other/ws1/abc.jpg", ENV)).toBeNull();
    expect(parseOwnMediaUrl("https://other.fra1.digitaloceanspaces.com/ws1/abc.jpg", ENV)).toBeNull();
    expect(parseOwnMediaUrl("https://example.com/x.jpg", ENV)).toBeNull();
    expect(parseOwnMediaUrl("ftp://crm.example.test/api/media/m1/public", ENV)).toBeNull();
    expect(parseOwnMediaUrl("not a url", ENV)).toBeNull();
    expect(parseOwnMediaUrl("", ENV)).toBeNull();
    // A malformed escape still names a media path: it is looked up raw (and so dropped).
    expect(parseOwnMediaUrl("https://crm.example.test/api/media/%E0%A4%A/public", ENV)).toEqual({ id: "%E0%A4%A" });
  });
});

describe("agentImageDecision", () => {
  const prisma = () =>
    makeFakePrisma({
      media: [
        { id: "ok", workspaceId: "ws1", mimeType: "image/jpeg", sizeBytes: 1000, approvedForAgent: true, storedPath: "ws1/ok.jpg" },
        { id: "hidden", workspaceId: "ws1", mimeType: "image/jpeg", sizeBytes: 1000, approvedForAgent: false, storedPath: "ws1/h.jpg" },
        { id: "pdf", workspaceId: "ws1", mimeType: "application/pdf", sizeBytes: 1000, approvedForAgent: true, storedPath: "ws1/p.pdf" },
        { id: "foreign", workspaceId: "ws2", mimeType: "image/png", sizeBytes: 1000, approvedForAgent: true, storedPath: "ws2/f.png" },
      ],
    });

  it.each([
    ["https://crm.example.test/api/media/ok/public?token=t", "send", "ok"],
    ["https://crm.example.test/api/media/hidden/public?token=t", "drop", "hidden"],
    ["https://crm.example.test/api/media/pdf/public?token=t", "drop", "pdf"],
    ["https://crm.example.test/api/media/foreign/public?token=t", "drop", "foreign"],
    ["https://crm.example.test/api/media/gone/public?token=t", "drop", "gone"],
    ["https://aram.fra1.digitaloceanspaces.com/ws1/ok.jpg?X-Amz-Signature=s", "send", "ok"],
    ["https://aram.fra1.digitaloceanspaces.com/ws1/h.jpg?X-Amz-Signature=s", "drop", "hidden"],
    ["https://aram.fra1.cdn.digitaloceanspaces.com/ws2/f.png", "drop", null],
    ["https://example.com/x.jpg", "external", null],
    // SP-17 review M1: variants of our URLs for a hidden row are dropped.
    ["https://crm.example.test/API/MEDIA/hidden/PUBLIC?token=t", "drop", "hidden"],
    ["https://crm.example.test./api/media/hidden/public?token=t", "drop", "hidden"],
    ["http://crm.example.test/api/media/hidden/public?token=t", "drop", "hidden"],
    ["https://backend-alias.example.net/api/media/hidden/public?token=t", "drop", "hidden"],
    ["https://crm.example.test/api/media/%68idden/public?token=t", "drop", "hidden"],
    ["https://crm.example.test/API/media/ok/public?token=t", "send", "ok"],
    ["https://ARAM.fra1.digitaloceanspaces.com./ws1/h.jpg?X-Amz-Signature=s", "drop", "hidden"],
    ["https://aram.fra1.digitaloceanspaces.com/ws1/%68.jpg", "drop", "hidden"],
  ])("%s -> %s", async (url, decision, mediaId) => {
    expect(await agentImageDecision(prisma(), "ws1", url, ENV)).toEqual({ decision, mediaId });
  });

  it.each([
    ["https://aram.fra1.cdn.digitaloceanspaces.com/ws1/h.jpg", "drop", "hidden"],
    ["https://aram.fra1.cdn.digitaloceanspaces.com/ws1/ok.jpg", "send", "ok"],
  ])("derived CDN host (no DO_SPACES_CDN_ENDPOINT): %s -> %s", async (url, decision, mediaId) => {
    const env = { ...ENV, DO_SPACES_CDN_ENDPOINT: undefined };
    expect(await agentImageDecision(prisma(), "ws1", url, env)).toEqual({ decision, mediaId });
  });

  it("a failing lookup of our URL is a drop (fail closed)", async () => {
    const broken = { media: { findFirst: jest.fn().mockRejectedValue(new Error("db down")) } };
    expect(
      await agentImageDecision(broken as never, "ws1", "https://crm.example.test/api/media/ok/public?token=t", ENV),
    ).toEqual({ decision: "drop", mediaId: "ok" });
  });

  it("an upper-case stored mime type is still a photo at send (matches list_photos)", async () => {
    const p = makeFakePrisma({
      media: [{ id: "up", workspaceId: "ws1", mimeType: "IMAGE/JPEG", sizeBytes: 1000, approvedForAgent: true, storedPath: "ws1/up.jpg" }],
    });
    expect(await agentImageDecision(p, "ws1", "https://crm.example.test/api/media/up/public", ENV)).toEqual({
      decision: "send",
      mediaId: "up",
    });
  });
});
