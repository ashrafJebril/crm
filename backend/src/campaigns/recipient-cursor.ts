import { campaignError } from "./campaign-errors";

/**
 * SP-12 keyset cursor for GET /campaigns/:id/recipients: base64url of
 * `{"v":1,"id":"<last id>","s":"<status|null>"}`. The status is part of the
 * cursor so a page token can't be replayed against another filter.
 */
interface CursorBody {
  v: 1;
  id: string;
  s: string | null;
}

export function encodeCursor(lastId: string, status: string | null | undefined): string {
  const body: CursorBody = { v: 1, id: lastId, s: status ?? null };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

/**
 * The last id of the previous page, or null for the first page.
 * 400 `campaigns.invalid_cursor` when malformed or minted for another status.
 */
export function decodeCursor(cursor: string | null | undefined, status: string | null | undefined): string | null {
  if (cursor === undefined || cursor === null || cursor === "") return null;
  let body: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("not base64url");
    body = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw campaignError("campaigns.invalid_cursor");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw campaignError("campaigns.invalid_cursor");
  const b = body as Partial<CursorBody>;
  if (b.v !== 1 || typeof b.id !== "string" || b.id === "") throw campaignError("campaigns.invalid_cursor");
  if ((b.s ?? null) !== (status ?? null)) throw campaignError("campaigns.invalid_cursor");
  return b.id;
}
