import * as mammoth from "mammoth";
import pdfParse from "pdf-parse";

/** Extract plain text from an uploaded file by mime type. */
export async function extractText(file: {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}): Promise<string> {
  switch (file.mimetype) {
    case "application/pdf":
      return parsePdf(file.buffer);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return parseDocx(file.buffer);
    case "text/plain":
    case "text/markdown":
      return file.buffer.toString("utf-8");
    default:
      throw new Error(`Unsupported file type: ${file.mimetype}`);
  }
}

async function parsePdf(buf: Buffer): Promise<string> {
  const result = await pdfParse(buf);
  return result.text.trim();
}

async function parseDocx(buf: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value.trim();
}
