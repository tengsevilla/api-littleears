export type ErrorCode =
  | "VALIDATION"
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "INVALID_CREDENTIALS"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REJECTED"
  | "PROVIDER_QUOTA"
  | "INTERNAL";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}
