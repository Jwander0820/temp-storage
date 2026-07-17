import type { Context } from "hono";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";

type AppContext = Context<AppEnv>;

export function handleError(error: Error, context: AppContext): Response {
  const requestId = context.get("requestId");

  if (error instanceof DomainError) {
    if (error.status >= 500) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "request.failed",
          requestId,
          code: error.code,
          message: error.message,
        }),
      );
    }

    return context.json(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId,
        },
      },
      error.status as 400 | 401 | 403 | 404 | 409 | 413 | 416 | 429 | 500 | 503 | 507,
    );
  }

  console.error(
    JSON.stringify({
      level: "error",
      event: "request.failed",
      requestId,
      message: error.message,
    }),
  );

  return context.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "服務暫時無法處理這個要求。",
        requestId,
      },
    },
    500,
  );
}
