import { CAMPAIGN_DIRECT_MAX, CAMPAIGN_MAX_PARTITIONS, campaignDirectMax, campaignMaxPartitions, partitionKey, planTransport } from "./partition";
import type { VarSlot } from "./var-map";

describe("partition", () => {
  const slots: VarSlot[] = [
    { source: "field", key: "name" },
    { source: "custom", key: "city" },
    { source: "static", value: "EID" },
    { source: "field", key: "email" },
  ];

  it("partitionKey hashes the channel and the non-native values only", () => {
    const k = partitionKey("chA", ["Sara", "Amman", "EID", "s@x.io"], slots);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    // Native slots (name, static) do not split partitions.
    expect(partitionKey("chA", ["Omar", "Amman", "EID", "s@x.io"], slots)).toBe(k);
    // Non-native ones do, and so does the sender.
    expect(partitionKey("chA", ["Sara", "Irbid", "EID", "s@x.io"], slots)).not.toBe(k);
    expect(partitionKey("chA", ["Sara", "Amman", "EID", "o@x.io"], slots)).not.toBe(k);
    expect(partitionKey("chB", ["Sara", "Amman", "EID", "s@x.io"], slots)).not.toBe(k);
    // No ambiguity from joining values.
    const two: VarSlot[] = [
      { source: "custom", key: "a" },
      { source: "custom", key: "b" },
    ];
    expect(partitionKey("c", ["a|b", "c"], two)).not.toBe(partitionKey("c", ["a", "b|c"], two));
    // A null channel (legacy default without a mirrored channel) is a valid key.
    expect(partitionKey(null, [], [])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("planTransport: broadcasts up to the partition cap, then direct up to the direct cap, else too_varied", () => {
    expect(CAMPAIGN_MAX_PARTITIONS).toBe(25);
    expect(CAMPAIGN_DIRECT_MAX).toBe(5000);
    const env = {};
    expect(planTransport({ partitions: 1, reachable: 100_000 }, env)).toBe("broadcast");
    expect(planTransport({ partitions: 25, reachable: 100_000 }, env)).toBe("broadcast");
    expect(planTransport({ partitions: 26, reachable: 5000 }, env)).toBe("direct");
    expect(planTransport({ partitions: 26, reachable: 5001 }, env)).toBe("too_varied");
    expect(planTransport({ partitions: 0, reachable: 0 }, env)).toBe("broadcast");
    // R8: a campaign header file forces direct sends.
    expect(planTransport({ partitions: 1, reachable: 10, headerOverride: true }, env)).toBe("direct");
    expect(planTransport({ partitions: 1, reachable: 5001, headerOverride: true }, env)).toBe("too_varied");
    // Env overrides.
    const low = { CAMPAIGN_MAX_PARTITIONS: "2", CAMPAIGN_DIRECT_MAX: "3" };
    expect(campaignMaxPartitions(low)).toBe(2);
    expect(campaignDirectMax(low)).toBe(3);
    expect(planTransport({ partitions: 3, reachable: 3 }, low)).toBe("direct");
    expect(planTransport({ partitions: 3, reachable: 4 }, low)).toBe("too_varied");
    expect(campaignMaxPartitions({ CAMPAIGN_MAX_PARTITIONS: "zero" })).toBe(25);
    expect(campaignDirectMax({ CAMPAIGN_DIRECT_MAX: "-1" })).toBe(5000);
  });
});
