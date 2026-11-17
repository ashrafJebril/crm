import { defaultPdfText } from "./knowledge-extract";

/** A minimal one-page PDF with a correct xref table. */
function makePdf(text: string): string {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

describe("defaultPdfText (real pdf-parse)", () => {
  it("parses a small PDF held in a pooled Buffer (non-zero byteOffset into a shared ArrayBuffer)", async () => {
    Buffer.from("something else in the pool first");
    const buf = Buffer.from(makePdf("Haircut fifty riyals"), "latin1");
    // The bug's precondition: the Buffer is a view into a larger, shared pool.
    expect(buf.byteOffset > 0 || buf.buffer.byteLength !== buf.byteLength).toBe(true);
    const r = await defaultPdfText(buf);
    expect(r.numpages).toBe(1);
    expect(r.text).toContain("Haircut fifty riyals");
  });

  it("parses a sliced view of a larger Buffer", async () => {
    const pdf = Buffer.from(makePdf("Beard trim thirty"), "latin1");
    const big = Buffer.alloc(pdf.length + 300, 0x25);
    pdf.copy(big, 150);
    const r = await defaultPdfText(big.subarray(150, 150 + pdf.length));
    expect(r.text).toContain("Beard trim thirty");
  });
});
