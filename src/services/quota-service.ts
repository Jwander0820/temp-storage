import type { PublicStorageUsage } from "../domain/quota";
import { getStorageUsage } from "../repositories/quota-repository";

export async function getPublicStorageUsage(database: D1Database): Promise<PublicStorageUsage> {
  const usage = await getStorageUsage(database);
  const committed = usage.used_bytes + usage.reserved_bytes;
  return {
    usedBytes: usage.used_bytes,
    reservedBytes: usage.reserved_bytes,
    maxBytes: usage.max_bytes,
    availableBytes: Math.max(0, usage.max_bytes - committed),
    usageRatio: Math.min(1, committed / usage.max_bytes),
  };
}
