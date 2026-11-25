import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SandboxNotice } from "./TryAgentPanel";
import { makeTx } from "@/lib/tx";

const tx = makeTx("en");

describe("SandboxNotice", () => {
  it("says the live agent answers when the workspace is linked", () => {
    const html = renderToStaticMarkup(<SandboxNotice engine="live" tx={tx} />);
    expect(html).toContain("Test run on your live agent.");
    expect(html).not.toContain("may differ");
  });

  it("warns that a preview may differ", () => {
    const html = renderToStaticMarkup(<SandboxNotice engine="preview" tx={tx} />);
    expect(html).toContain("Preview: replies may differ slightly from the live agent.");
  });

  it("keeps the preview wording until the server says which", () => {
    const html = renderToStaticMarkup(<SandboxNotice engine={undefined} tx={tx} />);
    expect(html).toContain("Preview:");
  });

  it("promises nothing is saved either way", () => {
    for (const engine of ["live", "preview"] as const) {
      expect(renderToStaticMarkup(<SandboxNotice engine={engine} tx={tx} />)).toContain("Nothing is saved");
    }
  });
});
