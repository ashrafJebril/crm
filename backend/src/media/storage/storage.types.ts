/** Common interface every storage backend implements. The MediaService talks
 *  to this, never to the underlying filesystem or S3 client directly, so we
 *  can swap backends with one env-var toggle. */
export interface MediaStorage {
  /** Identifier persisted in Media.storageKind for rows written here. */
  readonly kind: "local" | "spaces";

  /** Write a freshly uploaded buffer. Returns the storage key (relative path
   *  for local; bucket object key for Spaces) — caller persists it as
   *  Media.storedPath. */
  put(args: {
    workspaceId: string;
    buffer: Buffer;
    mimeType: string;
    originalFilename: string;
  }): Promise<{ key: string }>;

  /** Mint a short-lived URL the user's browser can hit directly to download
   *  the file. For local storage this routes back through the API; for
   *  Spaces this is an S3 pre-signed URL.
   *  `ttlSeconds` is advisory — local impl ignores it. */
  getSignedUrl(key: string, ttlSeconds: number): Promise<string>;

  /** Best-effort deletion. Resolves even if the object is already gone — DB
   *  is the source of truth, orphan bytes are tolerable. */
  delete(key: string): Promise<void>;
}
