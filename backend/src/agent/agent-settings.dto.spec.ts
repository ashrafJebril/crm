import { ArgumentMetadata, BadRequestException, ValidationPipe } from "@nestjs/common";
import { PatchAgentSettingsDto } from "./agent-settings.dto";

/** The app's global pipe settings. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta: ArgumentMetadata = { type: "body", metatype: PatchAgentSettingsDto };
const run = (body: unknown) => pipe.transform(body, meta);

describe("PatchAgentSettingsDto", () => {
  it("accepts one card or several, with a version", async () => {
    await expect(run({ identity: { nameEn: "Salma", tone: ["friendly"] }, version: 0 })).resolves.toBeInstanceOf(PatchAgentSettingsDto);
    await expect(
      run({ hours: { mode: "within", schedule: { mon: [{ from: "09:00", to: "17:00" }] } }, audience: { excludedTagIds: ["t1"] }, version: "2" }),
    ).resolves.toMatchObject({ version: 2 });
  });

  it("refuses unknown fields, a missing version, an unknown mode and over-long values", async () => {
    for (const body of [
      { version: 0, workspaceId: "other" },
      { identity: { nameEn: "x", stoppedAt: "now" }, version: 0 },
      { identity: { nameEn: "x" } },
      { hours: { mode: "sometimes" }, version: 0 },
      { identity: { nameEn: "x".repeat(61) }, version: 0 },
      { identity: { greeting: "x".repeat(501) }, version: 0 },
      { audience: { excludedTagIds: Array.from({ length: 51 }, (_, i) => `t${i}`) }, version: 0 },
      { hours: { mode: "within", schedule: "mon 9-5" }, version: 0 },
    ]) {
      await expect(run(body)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
