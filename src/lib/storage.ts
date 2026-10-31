// Private S3 (or R2 via S3_ENDPOINT) object storage. Keys only — callers never see bucket URLs (R4).
import type { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "./env.js";

export const s3 = new S3Client({
  region: env.S3_REGION,
  ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
});

const DELETE_BATCH = 1000; // DeleteObjects limit per request

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
}

export type ObjectStream = {
  body: Readable;
  contentType: string | undefined;
  contentLength: number | undefined;
  contentRange: string | undefined; // set when a Range was honoured (HTTP 206)
};

/** `range` is an HTTP Range header value, e.g. "bytes=0-1023", passed through to S3. */
export async function getObjectStream(key: string, range?: string): Promise<ObjectStream> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ...(range ? { Range: range } : {}) }));
  return {
    body: res.Body as Readable,
    contentType: res.ContentType,
    contentLength: res.ContentLength,
    contentRange: res.ContentRange,
  };
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  if (!res.Body) throw new Error("S3 object has no body");
  return Buffer.from(await res.Body.transformToByteArray());
}

/** HTTP status of an S3 SDK error (e.g. 404 NoSuchKey, 416 InvalidRange), if it has one. */
export function storageErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { name, $metadata } = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (name === "NoSuchKey") return 404;
  if (name === "InvalidRange") return 416;
  return typeof $metadata?.httpStatusCode === "number" ? $metadata.httpStatusCode : undefined;
}

/** Deletes every key (missing keys are fine — S3 deletes are idempotent). Throws if any key failed. */
export async function deleteObjects(keys: string[]): Promise<void> {
  const unique = [...new Set(keys)];
  for (let i = 0; i < unique.length; i += DELETE_BATCH) {
    const batch = unique.slice(i, i + DELETE_BATCH);
    const res = await s3.send(
      new DeleteObjectsCommand({
        Bucket: env.S3_BUCKET,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    );
    if (res.Errors?.length) {
      throw new Error(`S3 delete failed for ${res.Errors.length} object(s): ${res.Errors[0]?.Code ?? "unknown"}`);
    }
  }
}
