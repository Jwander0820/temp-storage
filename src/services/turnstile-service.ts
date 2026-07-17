import type { Bindings } from "../bindings";
import { DomainError } from "../domain/errors";
import { timingSafeStringEqual } from "../utils/hash";

interface TurnstileResult {
  readonly success: boolean;
  readonly hostname?: string;
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
  env: Bindings,
  token: string,
  remoteIp: string,
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
  if (!response.ok || !isTurnstileResult(payload) || !payload.success) {
    throw new DomainError("TURNSTILE_FAILED", 403, "人機驗證失敗，請重新操作。");
  }
}

export async function verifyOptionalAccessCode(
  env: Bindings,
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
