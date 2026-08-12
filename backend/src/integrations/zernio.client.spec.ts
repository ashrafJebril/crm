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

/**
 * Fix round 2 (2026-08-12): the paths assumed in Task 4 round 1
 * (`POST /inbox/comments/{commentId}/reply`, `DELETE /inbox/comments/{commentId}`)
 * were wrong — live probing against the real Zernio API returned 405 / 400.
 * The real endpoints (confirmed via https://docs.zernio.com/comments/reply-to-inbox-post
 * and https://docs.zernio.com/comments/delete-inbox-comment, and cross-checked with
 * live 400-validation probes) address the PARENT POST id in the path; `commentId`
 * is a separate body/query param. See task-4-report.md "Fix round 2" for the full
 * probe transcript.
 */
describe("ZernioClient comments", () => {
  let client: ZernioClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    process.env.ZERNIO_API_KEY = "test-key";
    client = new ZernioClient();
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true, data: { commentId: "c2" } })),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("replies to a post/comment via POST /inbox/comments/:postId", async () => {
    const res = await client.replyToComment("p1", "acc1", "thanks!", "c1");
    expect(res).toEqual({ id: "c2" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/inbox/comments/p1");
    expect(url).not.toContain("/reply");
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ accountId: "acc1", message: "thanks!", commentId: "c1" });
  });

  it("deletes a comment via DELETE /inbox/comments/:postId?accountId=&commentId=", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve("{}") });
    await client.deleteComment("p1", "acc1", "c1");
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/inbox/comments/p1");
    expect(url).toContain("accountId=acc1");
    expect(url).toContain("commentId=c1");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("fetches a post's real comments via GET /inbox/comments/:postId?accountId=", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            status: "success",
            comments: [
              {
                id: "cmt1",
                message: "hi",
                from: { name: "Jane" },
                likeCount: 2,
                createdTime: "2026-01-01T00:00:00Z",
              },
            ],
          }),
        ),
    });
    const comments = await client.getPostComments("p1", "acc1");
    expect(comments).toEqual([
      {
        id: "cmt1",
        message: "hi",
        from: { name: "Jane" },
        likeCount: 2,
        createdTime: "2026-01-01T00:00:00Z",
      },
    ]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/inbox/comments/p1");
    expect(url).toContain("accountId=acc1");
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  /**
   * Found live in Tier 0 verification (task-12): Zernio nests a comment's
   * replies under its own `replies` array — never as separate top-level rows.
   * The un-flattened version of `getPostComments` returned only top-level
   * comments, so `ZernioService.findCommentInWorkspace` (which searches this
   * method's output for a matching id) could never resolve a reply's own id —
   * a live reply-then-delete-that-reply round trip 404'd with "Comment not
   * found" even though the reply existed and was visible on Facebook.
   */
  it("flattens nested replies into individually-addressable rows", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            status: "success",
            comments: [
              {
                id: "top1",
                message: "hi",
                from: { name: "Jane" },
                replies: [
                  {
                    id: "reply1",
                    message: "🙏",
                    from: { name: "Page" },
                    replies: [{ id: "reply1-1", message: "nested twice", from: { name: "X" } }],
                  },
                ],
              },
              { id: "top2", message: "no replies here", from: { name: "Bob" } },
            ],
          }),
        ),
    });
    const comments = await client.getPostComments("p1", "acc1");
    expect(comments.map((c) => c.id)).toEqual(["top1", "reply1", "reply1-1", "top2"]);
    expect(comments.find((c) => c.id === "reply1")).toMatchObject({
      message: "🙏",
      parentId: "top1",
    });
    expect(comments.find((c) => c.id === "reply1-1")).toMatchObject({
      message: "nested twice",
      parentId: "reply1",
    });
    // Top-level rows keep parentId undefined rather than inheriting one.
    expect(comments.find((c) => c.id === "top2")?.parentId).toBeUndefined();
    // The nested `replies` key itself must not leak through onto flattened rows.
    expect(comments.every((c) => !("replies" in c))).toBe(true);
  });
});
