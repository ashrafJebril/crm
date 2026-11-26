/* eslint-disable @typescript-eslint/no-explicit-any */
import { HttpException } from "@nestjs/common";
import { LJoteckClient } from "../integrations/l-joteck.client";
import { crmTemplate, toCrm, toLKind } from "./l-knowledge";
import { A, failure, knowledgeWorld } from "./l-knowledge.fake";

describe("knowledge on l", () => {
  it("maps l kinds and templates to crm's", () => {
    const base = { id: "d1", status: "ready", title: "t", agent: "a" } as any;
    expect(toCrm({ ...base, kind: "guidelines", template: null })).toMatchObject({ kind: "guideline", typedKind: null, publishState: "none", legacy: false });
    expect(toCrm({ ...base, kind: "sheet", template: "offers" })).toMatchObject({ kind: "typed_doc", typedKind: "offers" });
    expect(toCrm({ ...base, kind: "sheet", template: "weekly-deals" })).toMatchObject({ kind: "typed_doc", typedKind: null });
    expect(toCrm({ ...base, kind: "file", template: null })).not.toHaveProperty("agent");
    expect([toLKind("guideline"), toLKind("typed_doc"), toLKind("faq")]).toEqual(["guidelines", "sheet", "faq"]);
  });

  it("offers expire on valid_to; an empty currency next to a price is SAR", () => {
    const t = crmTemplate("offers");
    expect(t.id).toBe("offers");
    expect(t.columns.find((c) => c.key === "valid_to")).toMatchObject({ type: "date", required: true, role: "expires_on" });
    expect(t.columns.find((c) => c.key === "currency")).toMatchObject({ type: "currency", default: "SAR", default_if: ["price", "original_price"] });
    expect(crmTemplate("packages").columns.find((c) => c.key === "valid_to")).not.toHaveProperty("role");
    expect(crmTemplate("inventory").columns.find((c) => c.key === "currency")!.default_if).toEqual(["price", "sale_price"]);
  });

  it("a typed upload sends crm's template; a plain one sends none", async () => {
    const w = knowledgeWorld();
    const f = { buffer: Buffer.from("a,b"), originalname: "offers.csv", mimetype: "text/csv", size: 3 };
    const typed = await w.svc.uploadFiles(A, "u", [f], { typedKind: "offers", acceptValidRows: "true" });
    expect(typed.items[0]).toMatchObject({ kind: "typed_doc", typedKind: "offers", status: "queued" });
    const form = w.calls[0].form!;
    expect(JSON.parse(String(form.get("template")))).toEqual(crmTemplate("offers"));
    expect(form.get("acceptValidRows")).toBe("true");
    await w.svc.uploadFiles(A, "u", [f]);
    expect(w.calls[1].form!.get("template")).toBeNull();
    expect(await failure(w.svc.uploadFiles(A, "u", [f], { typedKind: "secrets" }))).toMatchObject({ status: 400, body: { message: "knowledge.file_type" } });
  });

  it("guidelines are the workspace agent's; list filters by l kind", async () => {
    const w = knowledgeWorld();
    await w.svc.putGuidelines(A, "u", { body: "Be kind.", version: 0 });
    expect(w.calls[0]).toMatchObject({ method: "PUT", path: "/guidelines", body: { agent: "agent-a", body: "Be kind.", version: 0 } });
    expect(await w.svc.getGuidelines(A)).toMatchObject({ kind: "guideline", body: "Be kind." });
    const { items } = await w.svc.list(A, { kind: "guideline" });
    expect(items.map((s) => s.kind)).toEqual(["guideline"]);
    expect(w.calls.at(-1)!.path).toBe("/sources?kind=guidelines");
  });
});

describe("LJoteckClient knowledge errors", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });
  const reply = (status: number, body: unknown) =>
    jest.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  it("passes l's knowledge.* error bodies through, and hides anything else", async () => {
    process.env.L_API_URL = "https://l.example";
    process.env.L_JOTECK_SECRET = "s";
    const client = new LJoteckClient();
    jest.spyOn((client as any).logger, "warn").mockImplementation(() => undefined);
    reply(409, { statusCode: 409, message: "knowledge.version_conflict", current: { version: 3 } });
    const e = (await client.request("/x", { passErrors: "knowledge." }).catch((err) => err)) as HttpException;
    expect([e.getStatus(), e.getResponse()]).toEqual([409, { statusCode: 409, message: "knowledge.version_conflict", current: { version: 3 } }]);

    reply(500, { detail: "Traceback: secret stuff" });
    const hidden = (await client.request("/x", { passErrors: "knowledge." }).catch((err) => err)) as HttpException;
    expect([hidden.getStatus(), hidden.message]).toEqual([500, "Kewy AI platform returned an error"]);

    // A rejected service secret is never a user's 401.
    reply(401, { message: "knowledge.not_found" });
    expect(((await client.request("/x", { passErrors: "knowledge." }).catch((err) => err)) as HttpException).getStatus()).toBe(502);
  });
});
