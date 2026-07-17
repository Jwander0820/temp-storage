import type { Bindings } from "../bindings";
import { DomainError } from "../domain/errors";
import { claimDeletion, finalizeDeletion, getFile } from "../repositories/file-repository";
import { verifyPepperedValue } from "../utils/hash";

export async function deleteFileWithToken(
  env: Bindings,
  fileId: string,
  token: string,
  now: number,
): Promise<void> {
  const existing = await getFile(env.DB, fileId);
  if (existing === null) {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到檔案。");
  }
  if (
    existing.delete_token_hash === null ||
    !(await verifyPepperedValue(env.DELETE_TOKEN_PEPPER, token, existing.delete_token_hash))
  ) {
    throw new DomainError("INVALID_DELETE_TOKEN", 403, "刪除憑證不正確。");
  }
  await deleteFileAsAdmin(env, fileId, now);
}

export async function deleteFileAsAdmin(
  env: Pick<Bindings, "DB" | "FILES">,
  fileId: string,
  now: number,
): Promise<void> {
  const file = await claimDeletion(env.DB, fileId);
  if (file.status === "deleted") {
    return;
  }
  if (file.status !== "deleting") {
    throw new DomainError("FILE_NOT_FOUND", 404, "找不到可刪除的檔案。");
  }

  await env.FILES.delete(file.object_key);
  await finalizeDeletion(env.DB, file.id, file.size_bytes, now);
}
