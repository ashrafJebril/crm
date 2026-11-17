/* eslint-disable @typescript-eslint/no-explicit-any */
import { tenancyExtension } from "../common/prisma-tenancy";
import { workspaceContext } from "../common/workspace-context";

/** SP-27 review: ApiKey and the webhook models are in the tenancy list
 *  (defence in depth), and the AuthGuard lookup still works without one. */
const def = (tenancyExtension as any)({ $extends: (d: unknown) => d });
const handler = def.query.$allModels.$allOperations as (p: {
  model: string;
  operation: string;
  args: any;
  query: (a: any) => Promise<unknown>;
}) => Promise<unknown>;

const run = (model: string, operation: string, args: any) => handler({ model, operation, args, query: async (a) => a });

describe("SP-27 tenancy scoping", () => {
  it.each(["ApiKey", "WebhookEndpoint", "WebhookDelivery"])("%s reads, writes and creates are scoped to the request workspace", async (model) => {
    await workspaceContext.run({ workspaceId: "wsA", userId: "u" }, async () => {
      expect(await run(model, "findMany", { where: { workspaceId: "wsB" } })).toEqual({ where: { workspaceId: "wsA" } });
      expect(await run(model, "count", { where: {} })).toEqual({ where: { workspaceId: "wsA" } });
      expect(await run(model, "updateMany", { where: { id: "x" }, data: {} })).toMatchObject({ where: { id: "x", workspaceId: "wsA" } });
      expect(await run(model, "create", { data: { name: "n" } })).toMatchObject({ data: { workspaceId: "wsA", name: "n" } });
    });
  });

  it("AuthGuard's lookup by hash (no context) is untouched", async () => {
    expect(await run("ApiKey", "findUnique", { where: { hash: "h" } })).toEqual({ where: { hash: "h" } });
    expect(await run("ApiKey", "updateMany", { where: { id: "k" }, data: {} })).toEqual({ where: { id: "k" }, data: {} });
    // The dispatcher (no context) sees every workspace's due rows.
    expect(await run("WebhookDelivery", "findMany", { where: { status: "pending" } })).toEqual({ where: { status: "pending" } });
  });
});
