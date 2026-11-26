import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { assertStorageKey, type DocumentStorage } from "./document-storage.js";

export interface S3StorageConfig {
  bucket: string;
  region: string;
  /** For S3-compatible stores (R2, MinIO, Backblaze); unset for AWS S3. */
  endpoint?: string;
  /** Path-style URLs (MinIO usually needs this). */
  forcePathStyle?: boolean;
  /** Unset = the SDK's default chain (environment, instance role, …). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/** The part of the SDK client this class uses (so tests can pass a fake). */
export type S3Sender = Pick<S3Client, "send">;

/**
 * Documents in an S3-compatible bucket (ADR 0016). The bucket must be private (no public
 * access); objects are written with server-side encryption where the store supports it, and are
 * only ever read by the API, which streams them to authorised callers.
 */
export class S3Storage implements DocumentStorage {
  readonly driver = "s3" as const;
  private readonly bucket: string;
  private readonly client: S3Sender;
  /** AWS S3 only: some S3-compatible stores reject the header (they encrypt at rest themselves). */
  private readonly requestEncryption: boolean;

  constructor(config: S3StorageConfig, client?: S3Sender) {
    this.bucket = config.bucket;
    this.requestEncryption = !config.endpoint;
    this.client =
      client ??
      new S3Client({
        region: config.region,
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        ...(config.forcePathStyle ? { forcePathStyle: true } : {}),
        ...(config.credentials ? { credentials: config.credentials } : {}),
      });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertStorageKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        ...(this.requestEncryption ? { ServerSideEncryption: "AES256" as const } : {}),
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    assertStorageKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
