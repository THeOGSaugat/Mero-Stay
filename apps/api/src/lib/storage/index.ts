import type { StorageConfig } from "../../config/env.js";
import type { DocumentStorage } from "./document-storage.js";
import { LocalDiskStorage } from "./local-disk-storage.js";
import { S3Storage } from "./s3-storage.js";

export type { DocumentStorage } from "./document-storage.js";
export { documentStorageKey } from "./document-storage.js";
export { LocalDiskStorage } from "./local-disk-storage.js";
export { S3Storage } from "./s3-storage.js";

/** The storage implementation for the configured driver (ADR 0016). */
export function createDocumentStorage(config: StorageConfig): DocumentStorage {
  if (config.driver === "s3") {
    return new S3Storage({
      bucket: config.bucket,
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      ...(config.credentials ? { credentials: config.credentials } : {}),
    });
  }
  return new LocalDiskStorage(config.directory);
}
