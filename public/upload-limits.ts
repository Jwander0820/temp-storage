export interface LimitedUploadBatch<T> {
  readonly files: readonly T[];
  readonly omittedCount: number;
}

export function limitUploadBatch<T>(files: Iterable<T>, maxFiles: number): LimitedUploadBatch<T> {
  const selected = Array.from(files);
  return {
    files: selected.slice(0, maxFiles),
    omittedCount: Math.max(0, selected.length - maxFiles),
  };
}
