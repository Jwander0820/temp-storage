export type ErrorCode =
  | "INVALID_REQUEST"
  | "REQUEST_BODY_TOO_LARGE"
  | "TURNSTILE_FAILED"
  | "INVITATION_REQUIRED"
  | "INVITATION_INVALID"
  | "INVITATION_LIMIT_EXCEEDED"
  | "UPLOAD_NOT_ALLOWED"
  | "UPLOADS_DISABLED"
  | "FILE_TOO_LARGE"
  | "FILE_SIZE_MISMATCH"
  | "FILE_TYPE_BLOCKED"
  | "STORAGE_LIMIT_EXCEEDED"
  | "RATE_LIMITED"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_EXPIRED"
  | "RESERVATION_ALREADY_USED"
  | "UPLOAD_FAILED"
  | "FILE_NOT_FOUND"
  | "FILE_EXPIRED"
  | "PREVIEW_NOT_ALLOWED"
  | "INVALID_DELETE_TOKEN"
  | "INVALID_RANGE"
  | "INTERNAL_ERROR";

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
