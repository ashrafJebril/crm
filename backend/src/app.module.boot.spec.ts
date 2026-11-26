import { Test } from "@nestjs/testing";

/**
 * Every provider of the real app resolves (Nest's dependency graph), so a
 * module that injects something its imports do not export fails here, not
 * on boot in production. compile() builds the graph; nothing is started.
 */
describe("AppModule", () => {
  it("compiles: every provider's dependencies resolve", async () => {
    process.env.JWT_SECRET ||= "boot-test-secret-that-is-at-least-32-chars";
    process.env.DATABASE_URL ||= "postgresql://boot:boot@127.0.0.1:1/boot";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AppModule } = require("./app.module") as typeof import("./app.module");
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(mod).toBeDefined();
    await mod.close();
  }, 60_000);
});
