import { ZernioClient } from "./zernio.client";

describe("ZernioClient publishing", () => {
  let client: ZernioClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "test-key";
    client = new ZernioClient();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ post: { _id: "p1", status: "scheduled" } })),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("sends scheduledFor + timezone and publishNow:false when scheduling", async () => {
    const res = await client.createPost({
      content: "hello",
      platforms: [{ platform: "facebook", accountId: "acc1" }],
      scheduledFor: "2026-08-13T10:00:00.000Z",
      timezone: "Asia/Riyadh",
    });
    expect(res).toEqual({ id: "p1", status: "scheduled" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.publishNow).toBe(false);
    expect(body.scheduledFor).toBe("2026-08-13T10:00:00.000Z");
    expect(body.timezone).toBe("Asia/Riyadh");
  });

  it("defaults to publishNow:true when no scheduledFor", async () => {
    await client.createPost({
      content: "hello",
      platforms: [{ platform: "facebook", accountId: "acc1" }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.publishNow).toBe(true);
    expect(body.scheduledFor).toBeUndefined();
  });

  it("lists created posts from GET /posts", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ posts: [{ _id: "p1", status: "scheduled" }] })),
    });
    const posts = await client.listCreatedPosts("prof1");
    expect(posts).toHaveLength(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/posts?");
    expect(url).toContain("profileId=prof1");
  });

  it("cancels a post with DELETE /posts/:id", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("{}") });
    await client.cancelPost("p1");
    expect(String(fetchMock.mock.calls[0][0])).toContain("/posts/p1");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});

describe("ZernioClient comments", () => {
  let client: ZernioClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "test-key";
    client = new ZernioClient();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ id: "c2" })),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("replies to a comment", async () => {
    const res = await client.replyToComment("c1", "thanks!", "acc1");
    expect(res).toEqual({ id: "c2" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/inbox/comments/c1/reply");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ message: "thanks!", accountId: "acc1" });
  });

  it("deletes a comment", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("{}") });
    await client.deleteComment("c1", "acc1");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/inbox/comments/c1");
    expect(url).toContain("accountId=acc1");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});
