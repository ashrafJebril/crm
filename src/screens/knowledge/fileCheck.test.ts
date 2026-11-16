import { describe, expect, it } from "vitest";
import { makeTx } from "@/lib/tx";
import { checkBatch } from "./fileCheck";
import { knowledgeKeyText } from "./knowledgeErrors";

const MB = 1024 * 1024;

describe("upload checks before sending", () => {
  it("refuses a batch over 10 files, an ODS file and a file over 20 MB, with bilingual copy", () => {
    expect(checkBatch([{ name: "menu.pdf", size: MB }, { name: "photo.JPG", size: 2 * MB }])).toBeNull();
    const many = checkBatch(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.pdf`, size: 1 })));
    expect(many).toEqual({ key: "knowledge.batch_too_large", extra: { max: 10 } });
    expect(checkBatch([{ name: "prices.ods", size: 1 }])).toEqual({ key: "knowledge.file_type", extra: { fileName: "prices.ods" } });
    const big = checkBatch([{ name: "a.pdf", size: 1 }, { name: "huge.pdf", size: 21 * MB }]);
    expect(big?.key).toBe("knowledge.file_too_large");
    expect(knowledgeKeyText(big!.key, makeTx("en"), big!.extra)).toBe("huge.pdf is larger than 20 MB. Nothing was uploaded.");
    expect(knowledgeKeyText(many!.key, makeTx("ar"), many!.extra)).toMatch(/[؀-ۿ]/);
    expect(checkBatch([])).toBeNull();
  });
});
