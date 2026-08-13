import { Injectable, Logger } from "@nestjs/common";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { MediaStorage } from "./storage.types";

interface SpacesConfig {
  endpoint: string; // e.g. https://fra1.digitaloceanspaces.com
  region: string; // e.g. fra1
  bucket: string; // e.g. aram
  accessKey: string;
  secretKey: string;
  /** Optional CDN endpoint, e.g. https://aram.fra1.cdn.digitaloceanspaces.com.
   *  When set, signed URLs are issued against the CDN host so reads go through
   *  DO's edge network instead of the origin. */
  cdnEndpoint?: string;
}

/** DigitalOcean Spaces (S3-compatible) implementation. Uses Path-style URLs
 *  against `{region}.digitaloceanspaces.com` per DO docs — the bucket lives
 *  at `https://{bucket}.{region}.digitaloceanspaces.com`. */
@Injectable()
export class SpacesStorage implements MediaStorage {
  readonly kind = "spaces" as const;
  private readonly log = new Logger("SpacesStorage");
  private readonly client: S3Client;

  constructor(private readonly config: SpacesConfig) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      // DO Spaces is fine with virtual-hosted style; forcePathStyle:false is
      // the SDK default. Leaving explicit so future readers don't toggle it.
      forcePathStyle: false,
    });
    this.log.log(
      `Spaces storage active. Bucket=${config.bucket} region=${config.region}` +
        (config.cdnEndpoint ? ` cdn=${config.cdnEndpoint}` : ""),
    );
  }

  async put(args: {
    workspaceId: string;
    mimeType: string;
    originalFilename: string;
    buffer?: Buffer;
    sourcePath?: string;
  }): Promise<{ key: string }> {
    const ext = path
      .extname(args.originalFilename)
      .toLowerCase()
      .slice(0, 8);
    const id = randomBytes(8).toString("hex");
    const key = `${args.workspaceId}/${id}${ext}`;
    const body = args.sourcePath
      ? (await import("node:fs")).createReadStream(args.sourcePath)
      : args.buffer!;
    const contentLength = args.sourcePath
      ? (await (await import("node:fs/promises")).stat(args.sourcePath)).size
      : args.buffer!.length;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentType: args.mimeType,
        ContentLength: contentLength,
        // No ACL — bucket-default. We expose via signed URLs only.
      }),
    );
    return { key };
  }

  async getSignedUrl(key: string, ttlSeconds: number): Promise<string> {
    const cmd = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
    });
    const url = await getSignedUrl(this.client, cmd, {
      expiresIn: ttlSeconds,
    });
    if (this.config.cdnEndpoint) {
      // Rewrite the host portion to the CDN endpoint while keeping query
      // params (signature, expiry). The signature is valid for either host
      // as long as the bucket/key matches.
      try {
        const u = new URL(url);
        const cdn = new URL(this.config.cdnEndpoint);
        u.protocol = cdn.protocol;
        u.host = cdn.host;
        return u.toString();
      } catch (err) {
        this.log.warn(
          `Failed to rewrite CDN URL: ${(err as Error).message}; falling back to origin URL.`,
        );
      }
    }
    return url;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: key,
        }),
      );
    } catch (err) {
      this.log.warn(`Delete failed for ${key}: ${(err as Error).message}`);
    }
  }
}
