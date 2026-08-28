import type { Context } from "hono";
import type { AppEnv } from "../app-types";
import { DomainError } from "../domain/errors";

export async function readJsonBody(context: Context<AppEnv>): Promise<unknown> {
  try {
    return await context.req.json<unknown>();
  } catch {
    throw new DomainError("INVALID_REQUEST", 400, "要求內容必須是有效的 JSON。");
  }
}
