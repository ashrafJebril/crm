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

  it("the same path on another host is not ours", () => {
    expect(parseOwnMediaUrl("https://evil.test/api/media/m1/public?token=abc", ENV)).toBeNull();
    expect(parseOwnMediaUrl("https://crm.example.test/api/media/m1/file", ENV)).toBeNull();
  });

  it("Spaces virtual-hosted, path-style and CDN urls give the object-key candidates", () => {
    const key = { storedPathCandidates: ["ws1/abc.jpg"] };
    expect(parseOwnMediaUrl("https://aram.fra1.digitaloceanspaces.com/ws1/abc.jpg?X-Amz-Signature=s", ENV)).toEqual(key);
    expect(parseOwnMediaUrl("https://aram.fra1.cdn.digitaloceanspaces.com/ws1/abc.jpg?X-Amz-Expires=1", ENV)).toEqual(key);
    expect(parseOwnMediaUrl("https://fra1.digitaloceanspaces.com/aram/ws1/abc.jpg?X-Amz-Date=1", ENV)).toEqual(key);
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
    expect(parseOwnMediaUrl("https://crm.example.test/api/media/%E0%A4%A/public", ENV)).toBeNull();
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
  ])("%s -> %s", async (url, decision, mediaId) => {
    expect(await agentImageDecision(prisma(), "ws1", url, ENV)).toEqual({ decision, mediaId });
  });
});
