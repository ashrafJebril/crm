import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import type { Media } from "@/lib/types";
import {
  AGENT_PHOTO_MAX_BYTES,
  AGENT_PHOTO_MIMES,
  MEDIA_DETAIL_LIMITS,
  approvalBlock,
  approvalBlockText,
  approvalSwitchState,
  defaultTitle,
  detailsDraft,
  detailsPatch,
  displayTitle,
  parseTags,
  parseTagsWithOverflow,
} from "./mediaDetails";

const en = makeTx("en");
const ar = makeTx("ar");
const ARABIC = /[؀-ۿ]/;
const MB = 1024 * 1024;

const media = (over: Partial<Media> = {}): Media => ({
  id: "m1",
  workspaceId: "w",
  fileName: "menu.final.jpg",
  mimeType: "image/jpeg",
  sizeBytes: MB,
  storedPath: "",
  width: null,
  height: null,
  uploadedById: "u1",
  createdAt: "2026-11-01T00:00:00Z",
  title: null,
  alt: null,
  tags: [],
  useWhen: null,
  approvedForAgent: false,
  ...over,
});

describe("media details model", () => {
  it("mirrors the backend limits", () => {
    expect(MEDIA_DETAIL_LIMITS).toEqual({ title: 120, alt: 500, useWhen: 500, tag: 40, tags: 20 });
    expect([...AGENT_PHOTO_MIMES]).toEqual(["image/jpeg", "image/png"]);
    expect(AGENT_PHOTO_MAX_BYTES).toBe(5 * MB);
  });

  it("parseTags splits on latin and arabic commas and dedupes", () => {
    expect(parseTags("Menu، menu, قائمة ,, MENU")).toEqual(["menu", "قائمة"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags("  a b ,c")).toEqual(["a b", "c"]);
    const many = Array.from({ length: 23 }, (_, i) => `t${i}`).join(", ");
    const r = parseTagsWithOverflow(many);
    expect(r.tags).toHaveLength(20);
    expect(r.tags[0]).toBe("t0");
    expect(r.tags[19]).toBe("t19");
    expect(r.overflow).toBe(true);
    expect(parseTags(many)).toEqual(r.tags);
    expect(parseTagsWithOverflow("a, b").overflow).toBe(false);
    // Over-long tags are cut to the backend's 40 characters.
    expect(parseTags("x".repeat(45))).toEqual(["x".repeat(40)]);
  });

  it("detailsPatch sends only changed fields and clears with null", () => {
    const original = media({ title: "Menu", alt: "A menu", tags: ["menu"], useWhen: null });
    expect(detailsPatch(original, detailsDraft(original))).toBeNull();
    // Whitespace-only edits are no change.
    expect(detailsPatch(original, { ...detailsDraft(original), title: "  Menu  " })).toBeNull();
    expect(detailsPatch(original, { ...detailsDraft(original), title: " Lunch menu " })).toEqual({ title: "Lunch menu" });
    expect(detailsPatch(original, { ...detailsDraft(original), alt: "  " })).toEqual({ alt: null });
    expect(detailsPatch(original, { ...detailsDraft(original), useWhen: "When asked" })).toEqual({ useWhen: "When asked" });
    expect(detailsPatch(original, { ...detailsDraft(original), tagsText: "Menu، lunch" })).toEqual({ tags: ["menu", "lunch"] });
    expect(detailsPatch(original, { ...detailsDraft(original), tagsText: "" })).toEqual({ tags: [] });
    expect(detailsPatch(original, { ...detailsDraft(original), approvedForAgent: true })).toEqual({ approvedForAgent: true });
    expect(
      detailsPatch(original, { ...detailsDraft(original), title: "", approvedForAgent: true }),
    ).toEqual({ title: null, approvedForAgent: true });
    expect(detailsDraft(original).tagsText).toBe("menu");
  });

  it("approval is blocked for non-images, oversize and inbound files", () => {
    for (const mimeType of ["application/pdf", "video/mp4", "image/webp", "image/gif"]) {
      expect(approvalBlock(media({ mimeType }))).toBe("type");
    }
    expect(approvalBlock(media({ mimeType: "image/png", sizeBytes: 6 * MB }))).toBe("size");
    expect(approvalBlock(media({ uploadedById: null }))).toBe("inbound");
    expect(approvalBlock(media({ sizeBytes: 4 * MB }))).toBeNull();
    expect(approvalBlock(media({ mimeType: "IMAGE/PNG" }))).toBeNull();
    expect(approvalBlockText("type", en)).toBe("Only JPG or PNG photos");
    expect(approvalBlockText("size", en)).toBe("Larger than 5 MB");
    expect(approvalBlockText("inbound", en)).toBe("Customer attachments can't be approved");
    expect(approvalBlockText("type", ar)).toBe("صور JPG أو PNG فقط");
    expect(approvalBlockText("size", ar)).toBe("أكبر من 5 ميغابايت");
    expect(approvalBlockText("inbound", ar)).toBe("لا يمكن اعتماد مرفقات العملاء");
    for (const r of ["type", "size", "inbound"] as const) expect(approvalBlockText(r, ar)).toMatch(ARABIC);
  });

  it("defaultTitle drops the extension; displayTitle falls back to the file name", () => {
    expect(defaultTitle("menu.final.jpg")).toBe("menu.final");
    expect(defaultTitle("قائمة.png")).toBe("قائمة");
    expect(defaultTitle("noext")).toBe("noext");
    expect(defaultTitle(".hidden")).toBe(".hidden");
    expect(defaultTitle("x".repeat(130) + ".jpg")).toHaveLength(120);
    expect(displayTitle(media())).toBe("menu.final.jpg");
    expect(displayTitle(media({ title: "Menu" }))).toBe("Menu");
    // Rows from before SP-17 (or a list without the fields) still render.
    expect(displayTitle({ ...media(), title: undefined } as unknown as Media)).toBe("menu.final.jpg");
  });
});

describe("approval switch state mirrors the backend rule", () => {
  type Row = [
    name: string,
    media: Partial<Media>,
    draft: { title: string; approvedForAgent: boolean },
    canEdit: boolean,
    expected: { disabled: boolean; needsTitle: boolean; block: "type" | "size" | "inbound" | null },
  ];
  const rows: Row[] = [
    ["a staff JPEG can be switched on", {}, { title: "Menu", approvedForAgent: false }, true, { disabled: false, needsTitle: false, block: null }],
    ["approving with a title", { title: "Menu" }, { title: "Menu", approvedForAgent: true }, true, { disabled: false, needsTitle: false, block: null }],
    ["approving without a title needs one", {}, { title: "  ", approvedForAgent: true }, true, { disabled: false, needsTitle: true, block: null }],
    ["type: a PDF cannot be switched on", { mimeType: "application/pdf" }, { title: "x", approvedForAgent: false }, true, { disabled: true, needsTitle: false, block: "type" }],
    ["type: a WebP cannot be switched on", { mimeType: "image/webp" }, { title: "x", approvedForAgent: false }, true, { disabled: true, needsTitle: false, block: "type" }],
    ["size: a 6 MB PNG cannot be switched on", { mimeType: "image/png", sizeBytes: 6 * MB }, { title: "x", approvedForAgent: false }, true, { disabled: true, needsTitle: false, block: "size" }],
    ["inbound: a customer attachment cannot be switched on", { uploadedById: null }, { title: "x", approvedForAgent: false }, true, { disabled: true, needsTitle: false, block: "inbound" }],
    [
      "a blocked file approved earlier can still be switched off",
      { mimeType: "image/webp", approvedForAgent: true, title: "Old" },
      { title: "Old", approvedForAgent: true },
      true,
      { disabled: false, needsTitle: false, block: "type" },
    ],
    [
      "clearing the title of an approved row needs a title",
      { approvedForAgent: true, title: "Menu" },
      { title: "", approvedForAgent: true },
      true,
      { disabled: false, needsTitle: true, block: null },
    ],
    [
      "clearing the title while switching off is allowed",
      { approvedForAgent: true, title: "Menu" },
      { title: "", approvedForAgent: false },
      true,
      { disabled: false, needsTitle: false, block: null },
    ],
    [
      "an untitled row approved before SP-17 keeps editing other fields",
      { approvedForAgent: true, title: null },
      { title: "", approvedForAgent: true },
      true,
      { disabled: false, needsTitle: false, block: null },
    ],
    ["without knowledge.update the switch is disabled", {}, { title: "Menu", approvedForAgent: false }, false, { disabled: true, needsTitle: false, block: null }],
  ];
  it.each(rows)("%s", (_name, over, draft, canEdit, expected) => {
    expect(approvalSwitchState(media(over), draft, canEdit)).toEqual(expected);
  });
});
