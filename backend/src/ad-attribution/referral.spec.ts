import {
  BODY_MAX,
  HEADLINE_MAX,
  URL_MAX,
  adAccountIdOf,
  creativeLink,
  parseMetaReferral,
  parseZernioReferral,
} from "./referral";

const META = {
  source_url: "https://fb.me/abc",
  source_id: "120210000000001",
  source_type: "ad",
  body: "Spring sale body",
  headline: "Spring sale",
  media_type: "image",
  image_url: "https://scontent.xx.fbcdn.net/v/t45/img.jpg?oh=1",
  ctwa_clid: "ARAkLkA8rmlFeiCktEJQ",
  welcome_message: { text: "Hi! How can we help?" },
};

describe("parseMetaReferral", () => {
  it("keeps every field exactly as sent", () => {
    expect(parseMetaReferral(META)).toEqual({
      sourceId: "120210000000001",
      sourceType: "ad",
      headline: "Spring sale",
      body: "Spring sale body",
      mediaType: "image",
      mediaUrl: META.image_url,
      videoUrl: null,
      sourceUrl: "https://fb.me/abc",
      welcomeText: "Hi! How can we help?",
      ctwaClid: "ARAkLkA8rmlFeiCktEJQ",
      names: null,
    });
  });

  it("absent referral fields stay null (Status placement)", () => {
    const r = parseMetaReferral({ source_id: "1", source_type: "ad", media_type: "image" });
    expect(r).toMatchObject({ ctwaClid: null, mediaUrl: null, welcomeText: null, headline: null, body: null, sourceUrl: null });
  });

  it("drops over-long and non-https values to null, never truncating", () => {
    const r = parseMetaReferral({
      ...META,
      headline: "h".repeat(HEADLINE_MAX + 1),
      body: "b".repeat(BODY_MAX + 1),
      source_url: "http://fb.me/abc",
      image_url: `https://x.fbcdn.net/${"a".repeat(URL_MAX)}`,
      ctwa_clid: 42,
    });
    expect(r).toMatchObject({ headline: null, body: null, sourceUrl: null, mediaUrl: null, ctwaClid: null });
  });

  it("a referral without source_id is dropped with a key", () => {
    const keys: string[] = [];
    expect(parseMetaReferral({ ...META, source_id: undefined }, (k) => keys.push(k))).toBeNull();
    expect(keys).toEqual(["referral_missing_source_id"]);
    expect(parseMetaReferral(undefined)).toBeNull();
    expect(parseMetaReferral("x")).toBeNull();
  });

  it("other source types are kept verbatim; junk is refused", () => {
    expect(parseMetaReferral({ ...META, source_type: "post" })?.sourceType).toBe("post");
    expect(parseMetaReferral({ ...META, source_type: "Ad; DROP" })).toBeNull();
  });
});

describe("creativeLink", () => {
  it("image → image_url, video → thumbnail_url", () => {
    expect(creativeLink({ media_type: "image", image_url: "https://a.fbcdn.net/i.jpg", thumbnail_url: "https://a.fbcdn.net/t.jpg" })).toBe(
      "https://a.fbcdn.net/i.jpg",
    );
    expect(creativeLink({ media_type: "video", image_url: "https://a.fbcdn.net/i.jpg", thumbnail_url: "https://a.fbcdn.net/t.jpg" })).toBe(
      "https://a.fbcdn.net/t.jpg",
    );
    expect(creativeLink({ media_type: "video" })).toBeNull();
  });
  it("a video referral stores its thumbnail and its video link", () => {
    const r = parseMetaReferral({ ...META, media_type: "video", image_url: undefined, thumbnail_url: "https://v.fbcdn.net/t.jpg", video_url: "https://v.fbcdn.net/v.mp4" });
    expect(r).toMatchObject({ mediaType: "video", mediaUrl: "https://v.fbcdn.net/t.jpg", videoUrl: "https://v.fbcdn.net/v.mp4" });
  });
});

describe("parseZernioReferral", () => {
  const ad = (over: Record<string, unknown> = {}) => ({
    adId: "120210000000001",
    name: "Spring sale",
    synced: false,
    campaignName: "C",
    adSetName: "S",
    adAccountId: "998877",
    ...over,
  });

  it("zernio unsynced ad name is not stored", () => {
    const r = parseZernioReferral({ metadata: { referral: META, ad: ad() } });
    expect(r?.names).toBeNull();
    expect(r?.headline).toBe("Spring sale");
  });

  it("synced names and the ad account are taken", () => {
    const r = parseZernioReferral({ metadata: { referral: META, ad: ad({ synced: true, name: "Real ad name" }) } });
    expect(r?.names).toEqual({ adName: "Real ad name", adSetName: "S", campaignName: "C", adAccountId: "act_998877" });
  });

  it("reads root metadata and message.metadata", () => {
    expect(parseZernioReferral({ metadata: { referral: META } })?.sourceId).toBe("120210000000001");
    expect(parseZernioReferral({ message: { metadata: { referral: META } } })?.sourceId).toBe("120210000000001");
    // A root metadata without attribution does not hide message.metadata.
    expect(parseZernioReferral({ metadata: { buttonPayload: "x" }, message: { metadata: { referral: META } } })?.sourceId).toBe(
      "120210000000001",
    );
    expect(parseZernioReferral({ message: { metadata: { buttonPayload: "x" } } })).toBeNull();
    expect(parseZernioReferral({})).toBeNull();
  });

  it("an ad-only metadata.ad is a referral only on conversation.started", () => {
    const meta = { ad: ad() };
    expect(parseZernioReferral({ event: "message.received", metadata: meta })).toBeNull();
    expect(parseZernioReferral({ type: "message.received", message: { metadata: meta } })).toBeNull();
    expect(parseZernioReferral({ event: "conversation.started", metadata: meta })).toMatchObject({
      sourceId: "120210000000001",
      sourceType: "ad",
      headline: null,
    });
  });

  it("falls back to metadata.ad.adId when the referral has no source_id", () => {
    const r = parseZernioReferral({ metadata: { referral: { ...META, source_id: undefined, source_type: undefined }, ad: ad() } });
    expect(r).toMatchObject({ sourceId: "120210000000001", sourceType: "ad" });
  });

  it("names of a different ad are never attached", () => {
    const r = parseZernioReferral({ metadata: { referral: META, ad: ad({ synced: true, adId: "999" }) } });
    expect(r?.names).toBeNull();
  });
});

describe("adAccountIdOf", () => {
  it("normalises to act_<digits>", () => {
    expect(adAccountIdOf("act_1")).toBe("act_1");
    expect(adAccountIdOf("1")).toBe("act_1");
    expect(adAccountIdOf(12)).toBe("act_12");
    expect(adAccountIdOf("x1")).toBeNull();
    expect(adAccountIdOf(null)).toBeNull();
  });
});
