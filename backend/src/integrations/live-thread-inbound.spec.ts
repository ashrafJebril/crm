import { FacebookService } from "./facebook.service";
import { InstagramService } from "./instagram.service";
import { newestMessageInfo } from "./newest-message";

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
