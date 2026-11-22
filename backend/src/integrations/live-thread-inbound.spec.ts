import { FacebookService } from "./facebook.service";
import { InstagramService } from "./instagram.service";
import { HttpException } from "@nestjs/common";
import { isExpansionRejected, newestMessageInfo } from "./newest-message";

/**
 * Inbox views: live Facebook / Instagram threads carry `lastInboundAt` (and
 * who spoke last) from the newest message, read through a field expansion of
 * the one conversations-list request — never a Graph call per conversation.
 */
describe("newestMessageInfo", () => {
  it("customer last → lastFrom them and an ISO lastInboundAt; page last → no lastInboundAt", () => {
    expect(newestMessageInfo({ from: { id: "psid-1" }, created_time: "2026-11-22T09:30:00+0000" }, "page-1")).toEqual({
      lastFrom: "them",
      lastInboundAt: "2026-11-22T09:30:00.000Z",
    });
    expect(newestMessageInfo({ from: { id: "page-1" }, created_time: "2026-11-22T09:30:00+0000" }, "page-1")).toEqual({
      lastFrom: "page",
      lastInboundAt: null,
    });
    expect(newestMessageInfo({ from: { id: "psid-1" }, created_time: "junk" }, "page-1")).toEqual({ lastFrom: "them", lastInboundAt: null });
    expect(newestMessageInfo(undefined, "page-1")).toEqual({ lastInboundAt: null });
    expect(newestMessageInfo({ created_time: "2026-11-22T09:30:00+0000" }, "page-1")).toEqual({ lastInboundAt: null });
  });
});

function fakePrisma() {
  let n = 0;
  return {
    contact: { upsert: jest.fn(async () => ({ id: `contact-${++n}` })) },
    integration: {
      findFirst: jest.fn(async () => ({ pageId: "page-1" })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
}

describe("Facebook live threads carry lastInboundAt from one list request", () => {
  it("one Graph call with the nested newest message; customer-last and page-last threads", async () => {
    const svc = new FacebookService(fakePrisma() as never, {} as never);
    jest.spyOn(svc as never, "requireToken").mockResolvedValue({ token: "t", pageId: "page-1" } as never);
    const graphGet = jest.spyOn(svc as never, "graphGet").mockResolvedValue({
      data: [
        {
          id: "t_1",
          updated_time: "2026-11-22T10:00:00+0000",
          participants: { data: [{ id: "page-1" }, { id: "psid-a", name: "A" }] },
          messages: { data: [{ from: { id: "psid-a" }, created_time: "2026-11-22T09:00:00+0000" }] },
        },
        {
          id: "t_2",
          updated_time: "2026-11-22T10:00:00+0000",
          participants: { data: [{ id: "page-1" }, { id: "psid-b", name: "B" }] },
          messages: { data: [{ from: { id: "page-1" }, created_time: "2026-11-22T09:50:00+0000" }] },
        },
      ],
    } as never);
    const rows = await svc.listConversations("ws1");
    expect(graphGet).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(String(graphGet.mock.calls[0]![0]))).toContain("messages.limit(1){from,created_time}");
    expect(rows[0]).toMatchObject({ id: "t_1", lastFrom: "them", lastInboundAt: "2026-11-22T09:00:00.000Z" });
    expect(rows[1]).toMatchObject({ id: "t_2", lastFrom: "page", lastInboundAt: null });
  });
});

describe("Instagram live threads carry lastInboundAt from one list request", () => {
  it("one Graph call with the nested newest message", async () => {
    const svc = new InstagramService(fakePrisma() as never, {} as never);
    jest.spyOn(svc as never, "requireToken").mockResolvedValue({ token: "t", igUserId: "ig-own" } as never);
    const fetchJson = jest.spyOn(svc as never, "fetchJson").mockResolvedValue({
      data: [
        {
          id: "aWdfZ",
          updated_time: "2026-11-22T10:00:00+0000",
          participants: { data: [{ id: "ig-own" }, { id: "igsid-a", username: "a" }] },
          messages: { data: [{ from: { id: "igsid-a" }, created_time: "2026-11-22T08:15:00+0000" }] },
        },
      ],
    } as never);
    const rows = await svc.listConversations("ws1");
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(String(fetchJson.mock.calls[0]![0]))).toContain("messages.limit(1){from,created_time}");
    expect(rows[0]).toMatchObject({ id: "ig:aWdfZ", lastFrom: "them", lastInboundAt: "2026-11-22T08:15:00.000Z" });
  });
});

/**
 * B2: if Graph refuses the newest-message expansion (a field or permission
 * error), the list is fetched once more without it and returned exactly as
 * before the expansion existed; any other error is not retried.
 */
describe("the newest-message expansion falls back to the plain list once", () => {
  const refused = () => new HttpException("(#100) Tried accessing nonexisting field (messages) on node type (PageConversation)", 400);
  const plainRows = {
    data: [
      { id: "t_1", updated_time: "2026-11-22T10:00:00+0000", snippet: "hi", participants: { data: [{ id: "page-1" }, { id: "psid-a", name: "A" }] } },
    ],
  };

  it("classifies the errors", () => {
    expect(isExpansionRejected(refused())).toBe(true);
    expect(isExpansionRejected(new HttpException("(#10) Application does not have permission for this action", 400))).toBe(true);
    expect(isExpansionRejected(new HttpException("(#190) Error validating access token: Session has expired", 400))).toBe(false);
    expect(isExpansionRejected(new HttpException("Graph API unreachable", 502))).toBe(false);
    expect(isExpansionRejected(new HttpException("Graph API timed out", 504))).toBe(false);
    expect(isExpansionRejected(new Error("boom"))).toBe(false);
  });

  it("Facebook: the expansion is refused, the retry without it succeeds, the rows are as before", async () => {
    const svc = new FacebookService(fakePrisma() as never, {} as never);
    jest.spyOn(svc as never, "requireToken").mockResolvedValue({ token: "t", pageId: "page-1" } as never);
    const graphGet = jest
      .spyOn(svc as never, "graphGet")
      .mockRejectedValueOnce(refused() as never)
      .mockResolvedValueOnce(plainRows as never);
    const rows = await svc.listConversations("ws1");
    expect(graphGet).toHaveBeenCalledTimes(2);
    expect(decodeURIComponent(String(graphGet.mock.calls[0]![0]))).toContain("messages.limit(1)");
    expect(decodeURIComponent(String(graphGet.mock.calls[1]![0]))).not.toContain("messages");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "t_1", snippet: "hi", contactName: "A" });
    // Exactly the pre-expansion shape: no lastInboundAt / lastFrom keys at all.
    expect(rows[0]).not.toHaveProperty("lastInboundAt");
    expect(rows[0]).not.toHaveProperty("lastFrom");
  });

  it("Facebook: other errors are not retried", async () => {
    for (const err of [new HttpException("Graph API unreachable", 502), new HttpException("(#190) Error validating access token", 400)]) {
      const svc = new FacebookService(fakePrisma() as never, {} as never);
      jest.spyOn(svc as never, "requireToken").mockResolvedValue({ token: "t", pageId: "page-1" } as never);
      const graphGet = jest.spyOn(svc as never, "graphGet").mockRejectedValue(err as never);
      await expect(svc.listConversations("ws1")).rejects.toBe(err);
      expect(graphGet).toHaveBeenCalledTimes(1);
    }
  });

  it("Instagram: refused then retried without the expansion; other errors are not retried", async () => {
    const svc = new InstagramService(fakePrisma() as never, {} as never);
    jest.spyOn(svc as never, "requireToken").mockResolvedValue({ token: "t", igUserId: "ig-own" } as never);
    const fetchJson = jest
      .spyOn(svc as never, "fetchJson")
      .mockRejectedValueOnce(refused() as never)
      .mockResolvedValueOnce({ data: [{ id: "aWdfZ", updated_time: "2026-11-22T10:00:00+0000", participants: { data: [{ id: "ig-own" }, { id: "igsid-a", username: "a" }] } }] } as never)
      .mockResolvedValue({ count: 1 } as never);
    const rows = await svc.listConversations("ws1");
    expect(decodeURIComponent(String(fetchJson.mock.calls[0]![0]))).toContain("messages.limit(1)");
    expect(decodeURIComponent(String(fetchJson.mock.calls[1]![0]))).not.toContain("messages");
    expect(rows[0]).toMatchObject({ id: "ig:aWdfZ" });
    expect(rows[0]).not.toHaveProperty("lastInboundAt");

    const svc2 = new InstagramService(fakePrisma() as never, {} as never);
    jest.spyOn(svc2 as never, "requireToken").mockResolvedValue({ token: "t", igUserId: "ig-own" } as never);
    const err = new HttpException("Instagram Graph timed out", 504);
    const fetch2 = jest.spyOn(svc2 as never, "fetchJson").mockRejectedValue(err as never);
    await expect(svc2.listConversations("ws1")).rejects.toBe(err);
    expect(fetch2).toHaveBeenCalledTimes(1);
  });
});
