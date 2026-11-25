import { ArgumentMetadata, BadRequestException, RequestMethod, ValidationPipe } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { SandboxController, SandboxMessageDto } from "./sandbox.controller";

describe("SandboxController", () => {
  it("mounts GET/DELETE /agent/sandbox and POST /agent/sandbox/messages", () => {
    expect(Reflect.getMetadata(PATH_METADATA, SandboxController)).toBe("agent/sandbox");
    const proto = SandboxController.prototype as unknown as Record<string, () => unknown>;
    const route = (m: string) => [Reflect.getMetadata(METHOD_METADATA, proto[m]), Reflect.getMetadata(PATH_METADATA, proto[m])];
    expect(route("get")).toEqual([RequestMethod.GET, "/"]);
    expect(route("send")).toEqual([RequestMethod.POST, "messages"]);
    expect(route("reset")).toEqual([RequestMethod.DELETE, "/"]);
  });

  it("uses the JWT's workspace and member only", async () => {
    const svc = { get: jest.fn(async () => 1), send: jest.fn(async () => 2), reset: jest.fn(async () => 3) };
    const c = new SandboxController(svc as never);
    await c.get("ws1", "u1");
    await c.send("ws1", { userId: "u1", bypass: false }, { message: "hi" });
    await c.reset("ws1", "u1");
    expect(svc.get).toHaveBeenCalledWith("ws1", "u1");
    expect(svc.send).toHaveBeenCalledWith("ws1", "u1", "hi", expect.any(Date), { bypass: false });
    expect(svc.reset).toHaveBeenCalledWith("ws1", "u1");
  });

  it("the body is only {message}", async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const meta: ArgumentMetadata = { type: "body", metatype: SandboxMessageDto };
    await expect(pipe.transform({ message: "hi" }, meta)).resolves.toMatchObject({ message: "hi" });
    for (const body of [{ message: "hi", userId: "u2" }, { message: 3 }, {}]) await expect(pipe.transform(body, meta)).rejects.toBeInstanceOf(BadRequestException);
  });
});
