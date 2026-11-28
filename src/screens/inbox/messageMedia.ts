/**
 * Media-only messages are stored with a placeholder body ("[video]",
 * "[image]", …) next to the saved attachment. The placeholder is noise when
 * the media renders, and cryptic when the media could not be saved.
 */
export type PlaceholderKind = "image" | "video" | "audio" | "file" | "attachment";

const PLACEHOLDER = /^\[(image|video|audio|file|attachment|document|sticker)\]$/i;
/** Providers name some kinds differently: a "document" is a file, a "sticker" an image. */
const ALIAS: Record<string, PlaceholderKind> = { document: "file", sticker: "image" };

export function placeholderKind(body: string | null | undefined): PlaceholderKind | null {
  const m = PLACEHOLDER.exec(String(body ?? "").trim());
  if (!m) return null;
  const k = m[1].toLowerCase();
  return ALIAS[k] ?? (k as PlaceholderKind);
}

type Tx = (en: string, ar: string) => string;

/**
 * What the bubble shows as text:
 * - `{ text }` for an ordinary body (or a placeholder of an unknown kind),
 * - `{ text: "" }` when the attachment renders in its place,
 * - `{ missing }` when the media never saved: an honest label instead.
 */
export function messageBodyView(
  body: string,
  hasAttach: boolean,
  tx: Tx,
): { text: string; missing?: string } {
  const kind = placeholderKind(body);
  if (!kind) return { text: body };
  if (hasAttach) return { text: "" };
  const missing: Record<PlaceholderKind, string> = {
    video: tx("🎬 Video couldn't be loaded — view it in the app it came from", "🎬 تعذّر تحميل الفيديو — اعرضه في التطبيق الذي أُرسل منه"),
    image: tx("🖼️ Image couldn't be loaded — view it in the app it came from", "🖼️ تعذّر تحميل الصورة — اعرضها في التطبيق الذي أُرسلت منه"),
    audio: tx("🎙️ Voice message couldn't be loaded — listen in the app it came from", "🎙️ تعذّر تحميل الرسالة الصوتية — استمع إليها في التطبيق الذي أُرسلت منه"),
    file: tx("📎 File couldn't be loaded — open it in the app it came from", "📎 تعذّر تحميل الملف — افتحه في التطبيق الذي أُرسل منه"),
    attachment: tx("📎 Attachment couldn't be loaded — open it in the app it came from", "📎 تعذّر تحميل المرفق — افتحه في التطبيق الذي أُرسل منه"),
  };
  return { text: "", missing: missing[kind] };
}


/** How a fetched attachment blob is shown: played, listened to, opened as a file, or as an image. */
export type AttachmentView = "image" | "video" | "audio" | "file";

export function attachmentView(type: string | null | undefined): AttachmentView {
  const t = String(type ?? "").toLowerCase();
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t.startsWith("image/")) return "image";
  return "file";
}

/** A short name for a file chip: "PDF", "Word", … */
export function fileLabel(type: string | null | undefined, tx: Tx): string {
  const t = String(type ?? "").toLowerCase();
  if (t === "application/pdf") return "PDF";
  if (t.includes("wordprocessingml")) return "Word";
  if (t.includes("spreadsheetml")) return "Excel";
  if (t.includes("presentationml")) return "PowerPoint";
  return tx("File", "ملف");
}

/** PDFs open in the browser's own viewer; other files download. */
export function opensInBrowser(type: string | null | undefined): boolean {
  return String(type ?? "").toLowerCase() === "application/pdf";
}
