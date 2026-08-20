export interface StorageUsage {
  readonly used_bytes: number;
  readonly reserved_bytes: number;
  readonly max_bytes: number;
  readonly updated_at: number;
}

export interface PublicStorageUsage {
  readonly usedBytes: number;
  readonly reservedBytes: number;
  readonly maxBytes: number;
  readonly availableBytes: number;
  readonly usageRatio: number;
}

export interface UploadRateLimits {
  readonly reservationWindowSeconds: number;
  readonly reservationLimit: number;
  readonly hourlyWindowSeconds: number;
  readonly hourlyBytes: number;
  readonly dailyWindowSeconds: number;
  readonly dailyBytes: number;
}
