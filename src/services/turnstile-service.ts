import { DomainError } from "../domain/errors";
import { timingSafeStringEqual } from "../utils/hash";

interface TurnstileBindings {
  readonly TURNSTILE_SECRET_KEY: string;
  readonly TURNSTILE_TEST_MODE?: string;
  readonly UPLOAD_ORIGIN: string;
}

const OFFICIAL_ALWAYS_PASS_TEST_SECRET = "1x0000000000000000000000000000000AA";

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
  expectedAction: "invite" | "admin" = "invite",
): Promise<void> {
  if (token.length === 0 || token.length > 2048) {
    throw new DomainError("TURNSTILE_FAILED", 403, "人機驗證失敗，請重新操作。");
  }

  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
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
  const officialTestMode =
    env.TURNSTILE_TEST_MODE === "true" &&
    env.TURNSTILE_SECRET_KEY === OFFICIAL_ALWAYS_PASS_TEST_SECRET;
  if (
    !response.ok ||
    !isTurnstileResult(payload) ||
    !payload.success ||
    (!officialTestMode &&
      (payload.hostname !== expectedHostname || payload.action !== expectedAction))
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

  const normalizedCode = providedCode?.trim() ?? "";
  if (
    normalizedCode.length === 0 ||
    normalizedCode.length > 512 ||
    !(await timingSafeStringEqual(normalizedCode, expectedCode))
  ) {
    throw new DomainError("INVITATION_INVALID", 403, "邀請連結無效或已過期。");
  }
}
