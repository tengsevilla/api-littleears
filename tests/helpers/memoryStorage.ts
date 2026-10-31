// In-memory stand-in for lib/storage.ts (S3). Implements single byte ranges like S3 does.
import { Readable } from "node:stream";
import { vi } from "vitest";

type StoredObject = { body: Buffer; contentType: string };

function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

export function createMemoryStorage() {
  const objects = new Map<string, StoredObject>();

  const putObject = vi.fn(async (key: string, body: Buffer, contentType: string) => {
    objects.set(key, { body, contentType });
  });

  const getObjectBuffer = vi.fn(async (key: string) => {
    const o = objects.get(key);
    if (!o) throw s3Error("NoSuchKey", 404);
    return o.body;
  });

  const getObjectStream = vi.fn(async (key: string, range?: string) => {
    const o = objects.get(key);
    if (!o) throw s3Error("NoSuchKey", 404);
    const size = o.body.length;
    if (!range) return { body: Readable.from([o.body]), contentType: o.contentType, contentLength: size, contentRange: undefined };
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) throw new Error("memoryStorage: bad range");
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (!m[1]) start = Math.max(0, start);
    if (start >= size || start > end) throw s3Error("InvalidRange", 416);
    end = Math.min(end, size - 1);
    const slice = o.body.subarray(start, end + 1);
    return { body: Readable.from([slice]), contentType: o.contentType, contentLength: slice.length, contentRange: `bytes ${start}-${end}/${size}` };
  });

  const deleteObjects = vi.fn(async (keys: string[]) => {
    for (const k of keys) objects.delete(k);
  });

  return {
    objects,
    module: { putObject, getObjectBuffer, getObjectStream, deleteObjects },
    reset() {
      objects.clear();
      for (const fn of [putObject, getObjectBuffer, getObjectStream, deleteObjects]) fn.mockClear();
    },
  };
}
