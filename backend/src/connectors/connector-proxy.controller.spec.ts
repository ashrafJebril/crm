import { ConnectorProxyController } from "./connector-proxy.controller";

function build() {
  const rpc = { handle: jest.fn().mockResolvedValue({ jsonrpc: "2.0", id: 1, result: {} }) };
  const controller = new ConnectorProxyController(rpc as never);
  const req = { connector: { id: "c1" } } as never;
  const res = { status: jest.fn() } as never;
  const call = (sandbox?: string, l?: string) => controller.handle("c1", {}, sandbox, l, req, res);
  return { rpc, call };
}

describe("ConnectorProxyController dry run", () => {
  it.each([
    ["the sandbox header", "1", undefined],
    ["l's dry-run header", undefined, "1"],
  ])("refuses writes on %s", async (_label, sandbox, l) => {
    const { rpc, call } = build();
    await call(sandbox, l);
    expect(rpc.handle).toHaveBeenCalledWith(expect.anything(), {}, { dryRun: true });
  });

  it("runs a live turn without either header", async () => {
    const { rpc, call } = build();
    await call(undefined, undefined);
    expect(rpc.handle).toHaveBeenCalledWith(expect.anything(), {}, { dryRun: false });
  });
});
