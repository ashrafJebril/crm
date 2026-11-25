import { IMPORT_EXPECTED_MS, IMPORT_GIVE_UP_MS, importStatus } from "./zernio-import";

const now = Date.parse("2026-11-25T13:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("importStatus", () => {
  it("is importing right after connect, expected done 90 min after connect", () => {
    const s = importStatus({ connectedAt: ago(30 * 60_000), postCount: 0, lastSync: null, syncTriggered: true, now });
    expect(s.importing).toBe(true);
    expect(s.expectedBy).toBe(new Date(now - 30 * 60_000 + IMPORT_EXPECTED_MS).toISOString());
    expect(s.postCount).toBe(0);
    expect(s.syncTriggered).toBe(true);
  });

  it("keeps importing past the expected time, up to the give-up window", () => {
    const s = importStatus({ connectedAt: ago(IMPORT_GIVE_UP_MS - 1), postCount: 2, lastSync: null, syncTriggered: false, now });
    expect(s.importing).toBe(true);
  });

  it("stops importing once the give-up window has passed", () => {
    const s = importStatus({ connectedAt: ago(IMPORT_GIVE_UP_MS), postCount: 0, lastSync: ago(60_000), syncTriggered: false, now });
    expect(s.importing).toBe(false);
    expect(s.expectedBy).toBeNull();
    expect(s.lastSync).toBe(ago(60_000));
  });

  it("is not importing when the connect time is unknown or unparseable", () => {
    expect(importStatus({ connectedAt: null, postCount: 0, lastSync: null, syncTriggered: false, now }).importing).toBe(false);
    expect(importStatus({ connectedAt: "garbage", postCount: 0, lastSync: null, syncTriggered: false, now }).importing).toBe(false);
  });

  it("is not importing for a connect time in the future (clock skew)", () => {
    const s = importStatus({ connectedAt: new Date(now + 60_000).toISOString(), postCount: 0, lastSync: null, syncTriggered: false, now });
    expect(s.importing).toBe(false);
  });
});
