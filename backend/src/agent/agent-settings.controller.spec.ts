import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { AgentSettingsController } from "./agent-settings.controller";

describe("AgentSettingsController", () => {
  it("mounts GET/PATCH /agent/settings and POST /agent/settings/resync", () => {
    expect(Reflect.getMetadata(PATH_METADATA, AgentSettingsController)).toBe("agent/settings");
    const proto = AgentSettingsController.prototype as unknown as Record<string, () => unknown>;
    const route = (m: string) => [Reflect.getMetadata(METHOD_METADATA, proto[m]), Reflect.getMetadata(PATH_METADATA, proto[m])];
    expect(route("get")).toEqual([RequestMethod.GET, "/"]);
    expect(route("patch")).toEqual([RequestMethod.PATCH, "/"]);
    expect(route("resync")).toEqual([RequestMethod.POST, "resync"]);
  });

  it("passes the JWT workspace to the service, never a body field", async () => {
    const svc = { get: jest.fn(async () => "g"), update: jest.fn(async () => "u"), resync: jest.fn(async () => "r") };
    const c = new AgentSettingsController(svc as never);
    await c.get("ws1");
    await c.patch("ws1", { version: 0 } as never);
    await c.resync("ws1");
    expect(svc.get).toHaveBeenCalledWith("ws1");
    expect(svc.update).toHaveBeenCalledWith("ws1", { version: 0 });
    expect(svc.resync).toHaveBeenCalledWith("ws1");
  });
});
