import { ArgumentMetadata, BadRequestException, RequestMethod, ValidationPipe } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { ApplyLearnDto, OnboardingController, OnboardingWebsiteDto, PatchOnboardingDto } from "./onboarding.controller";

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const run = (metatype: new () => object, body: unknown) => pipe.transform(body, { type: "body", metatype } as ArgumentMetadata);

describe("OnboardingController", () => {
  it("mounts the five routes", () => {
    expect(Reflect.getMetadata(PATH_METADATA, OnboardingController)).toBe("onboarding");
    const proto = OnboardingController.prototype as unknown as Record<string, () => unknown>;
    const route = (m: string) => [Reflect.getMetadata(METHOD_METADATA, proto[m]), Reflect.getMetadata(PATH_METADATA, proto[m])];
    expect(route("get")).toEqual([RequestMethod.GET, "/"]);
    expect(route("patch")).toEqual([RequestMethod.PATCH, "/"]);
    expect(route("website")).toEqual([RequestMethod.POST, "website"]);
    expect(route("learn")).toEqual([RequestMethod.POST, "learn"]);
    expect(route("apply")).toEqual([RequestMethod.POST, "learn/apply"]);
  });

  it("passes the JWT workspace and viewer", async () => {
    const svc = { get: jest.fn(), patch: jest.fn(), website: jest.fn(), learn: jest.fn(), apply: jest.fn() };
    const c = new OnboardingController(svc as never);
    const v = { userId: "u1", bypass: false };
    await c.get("ws1", v);
    await c.patch("ws1", v, { action: "start" });
    await c.website("ws1", v, { url: "https://a.example" });
    await c.learn("ws1", v);
    await c.apply("ws1", v, { faqs: [0] });
    expect(svc.get).toHaveBeenCalledWith("ws1", v);
    expect(svc.patch).toHaveBeenCalledWith("ws1", v, { action: "start" });
    expect(svc.apply).toHaveBeenCalledWith("ws1", v, { faqs: [0] });
  });

  it("validates the bodies (unknown fields are 400)", async () => {
    await expect(run(PatchOnboardingDto, { action: "start", businessName: "Noor" })).resolves.toBeTruthy();
    await expect(run(OnboardingWebsiteDto, { url: "https://a.example" })).resolves.toBeTruthy();
    await expect(run(ApplyLearnDto, { description: "append", faqs: [0, 2], hours: true })).resolves.toBeTruthy();
    for (const [m, body] of [
      [PatchOnboardingDto, { action: "takeover" }],
      [PatchOnboardingDto, { action: "start", startedBy: "u2" }],
      [OnboardingWebsiteDto, { url: "https://a.example", scope: "path" }],
      [ApplyLearnDto, { description: "rewrite" }],
      [ApplyLearnDto, { faqs: [-1] }],
      [ApplyLearnDto, { services: true }],
    ] as const) {
      await expect(run(m as never, body)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
