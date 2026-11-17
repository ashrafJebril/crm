/**
 * Copies text with the async clipboard API. Resolves false when the API is
 * missing (http, old browsers, some in-app webviews) or the browser denies
 * it, so the caller can fall back to "Select and copy" (review M4).
 */
export async function copyText(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined | null = globalThis.navigator?.clipboard): Promise<boolean> {
  if (!clipboard || typeof clipboard.writeText !== "function") return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
