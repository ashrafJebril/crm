import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ImportBanner } from "./ImportBanner";
import { makeTx } from "@/lib/tx";

const min = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const status = {
  connected: true,
  connectedAt: min(-30),
  importing: true,
  expectedBy: min(60),
  postCount: 2,
  lastSync: min(-4),
  syncTriggered: false,
};

describe("ImportBanner", () => {
  it("shows count, time left and last sync while importing", () => {
    const html = renderToStaticMarkup(
      <ImportBanner status={status} platformLabel="Facebook" postsShown={0} tx={makeTx("en")} />,
    );
    expect(html).toContain("Importing your existing posts from Facebook · 2 so far");
    expect(html).toContain("Connected 30 min ago · about 60 min left · last synced 4 min ago");
    expect(html).toContain('aria-valuenow="33"');
  });

  it("renders nothing once the import is over", () => {
    const html = renderToStaticMarkup(
      <ImportBanner status={{ ...status, importing: false }} platformLabel="Facebook" postsShown={5} tx={makeTx("en")} />,
    );
    expect(html).toBe("");
  });
});
