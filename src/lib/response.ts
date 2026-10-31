import type { ErrorCode } from "./errors.js";

export type Meta = Record<string, unknown>;

// Cross-agent API contract (workspace CLAUDE.md) — meta is always present.
export type ApiResponse<T> = {
  data: T | null;
  error: { code: string; message: string } | null;
  meta: Meta;
};

export function ok<T>(data: T, meta: Meta = {}): ApiResponse<T> {
  return { data, error: null, meta };
}

export function fail(code: ErrorCode, message: string): ApiResponse<never> {
  return { data: null, error: { code, message }, meta: {} };
}
