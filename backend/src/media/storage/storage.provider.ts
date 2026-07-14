import { Logger, type FactoryProvider } from "@nestjs/common";
import { LocalStorage } from "./local-storage";
import { SpacesStorage } from "./spaces-storage";
import type { MediaStorage } from "./storage.types";

export const MEDIA_STORAGE = Symbol("MEDIA_STORAGE");

/** Returns SpacesStorage when DO_SPACES_KEY + DO_SPACES_SECRET + DO_SPACES_BUCKET
 *  are all set; otherwise falls back to LocalStorage. This lets dev workstations
 *  run without credentials and lets prod opt in by setting a few env vars — no
 *  code change required. */
export const MediaStorageProvider: FactoryProvider<MediaStorage> = {
  provide: MEDIA_STORAGE,
  useFactory: (): MediaStorage => {
    const log = new Logger("MediaStorageProvider");
    const key = process.env.DO_SPACES_KEY;
    const secret = process.env.DO_SPACES_SECRET;
    const bucket = process.env.DO_SPACES_BUCKET;
    const region = process.env.DO_SPACES_REGION;
    const endpoint = process.env.DO_SPACES_ENDPOINT;

    const haveAll = key && secret && bucket && region && endpoint;
    if (haveAll) {
      return new SpacesStorage({
        endpoint,
        region,
        bucket,
        accessKey: key,
        secretKey: secret,
        cdnEndpoint: process.env.DO_SPACES_CDN_ENDPOINT || undefined,
      });
    }

    if (key || secret || bucket || region || endpoint) {
      log.warn(
        "Partial DO_SPACES_* configuration detected — falling back to LocalStorage. " +
          "Set all of DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_BUCKET, DO_SPACES_REGION, " +
          "DO_SPACES_ENDPOINT to enable Spaces.",
      );
    } else {
      log.log("Using LocalStorage (no DO_SPACES_* env vars set).");
    }
    return new LocalStorage();
  },
};
