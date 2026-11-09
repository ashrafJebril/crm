import "reflect-metadata";
import { ChannelsController } from "./channels.controller";
import { ROUTE_PERMISSIONS, routesOf } from "../permissions/permission-map";

describe("ChannelsController", () => {
  it("exposes the T1 routes with their SP-25 permissions", () => {
    const keys = routesOf(ChannelsController)
      .map((r) => r.key)
      .sort();
    expect(Object.fromEntries(keys.map((k) => [k, ROUTE_PERMISSIONS[k]]))).toEqual({
      "DELETE /channels/:id": "channels.delete",
      "GET /channels": "channels.view",
      "GET /channels/:id": "channels.view",
      "GET /channels/limits": "channels.view",
      "PATCH /channels/:id": "channels.update",
      "POST /channels": "channels.create",
      "POST /channels/:id/reconnect": "channels.update",
      "POST /channels/sync": "channels.update",
    });
  });

  it("/limits reports encryption state only to channels.update holders", async () => {
    const svc = { limits: jest.fn(async () => ({})) };
    const perm = { viewerCan: jest.fn(async () => false) };
    const ctrl = new ChannelsController(svc as never, perm as never);
    await ctrl.limits("ws1", { userId: "u" } as never);
    expect(svc.limits).toHaveBeenCalledWith("ws1", false);
    perm.viewerCan.mockResolvedValue(true);
    await ctrl.limits("ws1", { userId: "u" } as never);
    expect(svc.limits).toHaveBeenLastCalledWith("ws1", true);
    expect(perm.viewerCan).toHaveBeenCalledWith("ws1", { userId: "u" }, "channels.update");
  });

  it("GET /channels passes the kind filter through", async () => {
    const svc = { list: jest.fn(async () => []) };
    const ctrl = new ChannelsController(svc as never, undefined);
    await ctrl.list("ws1", "whatsapp");
    expect(svc.list).toHaveBeenCalledWith("ws1", "whatsapp");
  });
});
