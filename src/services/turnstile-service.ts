import { DomainError } from "../domain/errors";
import { timingSafeStringEqual } from "../utils/hash";

interface TurnstileBindings {
  readonly TURNSTILE_SECRET_KEY: string;
  readonly UPLOAD_ORIGIN: string;
}

interface AccessCodeBindings {
  readonly UPLOAD_ACCESS_CODE?: string;
}

interface TurnstileResult {
  readonly success: boolean;
  readonly hostname?: string;
  readonly action?: string;
  readonly "error-codes"?: string[];
}

function isTurnstileResult(value: unknown): value is TurnstileResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    typeof value.success === "boolean"
  );
}

export async function verifyTurnstile(
  env: TurnstileBindings,
  token: string,
  remoteIp: string,
  requestId?: string,
): Promise<void> {
  if (token.length === 0 || token.length > 2048) {
    throw new DomainError("TURNSTILE_FAILED", 403, "人機驗證失敗，請重新操作。");
  }

  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteIp,
        idempotency_key: crypto.randomUUID(),
      }),
    });
  } catch {
    throw new DomainError("TURNSTILE_FAILED", 403, "人機驗證暫時無法完成，請稍後再試。");
  }

  const payload: unknown = await response.json<unknown>();
  const expectedHostname = new URL(env.UPLOAD_ORIGIN).hostname;
  if (
    !response.ok ||
    !isTurnstileResult(payload) ||
    !payload.success ||
    payload.hostname !== expectedHostname ||
    payload.action !== "upload"
  ) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "turnstile.rejected",
        errorCodes: isTurnstileResult(payload) ? (payload["error-codes"] ?? []) : [],
        hostname: isTurnstileResult(payload) ? (payload.hostname ?? null) : null,
        action: isTurnstileResult(payload) ? (payload.action ?? null) : null,
        requestId: requestId ?? null,
      }),
    );
    throw new DomainError("TURNSTILE_FAILED", 403, "人機驗證失敗，請重新操作。");
  }
}

export async function verifyOptionalAccessCode(
  env: AccessCodeBindings,
  providedCode: string | null,
): Promise<void> {
  const expectedCode = env.UPLOAD_ACCESS_CODE?.trim();
  if (!expectedCode) {
    return;
  }

  if (providedCode === null || !(await timingSafeStringEqual(providedCode.trim(), expectedCode))) {
    throw new DomainError("INVALID_REQUEST", 403, "上傳分享碼不正確。");
  }
}
