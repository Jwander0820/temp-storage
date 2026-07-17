import { DomainError } from "../domain/errors";

export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

export function parseRangeHeader(header: string, totalBytes: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || totalBytes <= 0) {
    throw new DomainError("INVALID_RANGE", 416, "要求的檔案範圍無法滿足。");
  }

  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") {
    throw new DomainError("INVALID_RANGE", 416, "要求的檔案範圍無法滿足。");
  }

  if (startText === "") {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      throw new DomainError("INVALID_RANGE", 416, "要求的檔案範圍無法滿足。");
    }
    const length = Math.min(suffix, totalBytes);
    return { offset: totalBytes - length, length };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalBytes) {
    throw new DomainError("INVALID_RANGE", 416, "要求的檔案範圍無法滿足。");
  }

  if (endText === "") {
    return { offset: start, length: totalBytes - start };
  }

  const end = Number(endText);
  if (!Number.isSafeInteger(end) || end < start) {
    throw new DomainError("INVALID_RANGE", 416, "要求的檔案範圍無法滿足。");
  }

  const boundedEnd = Math.min(end, totalBytes - 1);
  return { offset: start, length: boundedEnd - start + 1 };
}
