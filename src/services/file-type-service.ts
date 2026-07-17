import type { PreviewPolicy } from "../domain/file";

const BLOCKED_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/javascript",
  "application/javascript",
  "application/wasm",
  "text/css",
  "application/xml",
  "text/xml",
  "application/x-shockwave-flash",
]);

const INLINE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
]);

const ACTIVE_TEXT_PREFIXES = [
  "<!doctype html",
  "<html",
  "<head",
  "<body",
  "<script",
  "<svg",
  "<?xml",
  '"use strict"',
  "'use strict'",
  "import ",
  "export ",
  "function ",
  "const ",
  "let ",
  "var ",
];

export interface FileClassification {
  readonly detectedMime: string;
  readonly previewPolicy: PreviewPolicy;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function detectIsoBmff(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 12 || ascii(bytes, 4, 4) !== "ftyp") {
    return null;
  }

  const brands: string[] = [];
  for (let offset = 8; offset + 4 <= Math.min(bytes.byteLength, 64); offset += 4) {
    brands.push(ascii(bytes, offset, 4));
  }

  if (brands.some((brand) => brand === "avif" || brand === "avis")) {
    return "image/avif";
  }
  if (brands.some((brand) => brand === "M4A " || brand === "M4B ")) {
    return "audio/mp4";
  }
  if (
    brands.some((brand) =>
      ["isom", "iso2", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "qt  "].includes(
        brand,
      ),
    )
  ) {
    return "video/mp4";
  }
  return null;
}

function looksLikeActiveText(bytes: Uint8Array): boolean {
  const sample = new TextDecoder("utf-8")
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 2048)))
    .replace(/^\uFEFF/u, "")
    .trimStart()
    .toLowerCase();

  return ACTIVE_TEXT_PREFIXES.some((prefix) => sample.startsWith(prefix));
}

export function isBlockedDeclaredMime(declaredMime: string | null): boolean {
  if (declaredMime === null) {
    return false;
  }
  return BLOCKED_MIME_TYPES.has(declaredMime.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}

export function classifyFile(
  bytes: Uint8Array,
  extension: string | null,
  declaredMime: string | null,
): FileClassification {
  if (looksLikeActiveText(bytes)) {
    return { detectedMime: "application/octet-stream", previewPolicy: "blocked" };
  }

  let detectedMime = detectIsoBmff(bytes);
  if (detectedMime === null && startsWith(bytes, [0xff, 0xd8, 0xff])) {
    detectedMime = "image/jpeg";
  } else if (
    detectedMime === null &&
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    detectedMime = "image/png";
  } else if (
    detectedMime === null &&
    (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
  ) {
    detectedMime = "image/gif";
  } else if (
    detectedMime === null &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    detectedMime = "image/webp";
  } else if (
    detectedMime === null &&
    startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) &&
    (extension === "webm" || declaredMime?.startsWith("video/webm") === true)
  ) {
    detectedMime = "video/webm";
  } else if (
    detectedMime === null &&
    startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]) &&
    declaredMime?.startsWith("audio/webm") === true
  ) {
    detectedMime = "audio/webm";
  } else if (
    detectedMime === null &&
    (ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
  ) {
    detectedMime = "audio/mpeg";
  } else if (detectedMime === null && ascii(bytes, 0, 4) === "OggS") {
    detectedMime = "audio/ogg";
  } else if (
    detectedMime === null &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WAVE"
  ) {
    detectedMime = "audio/wav";
  } else if (detectedMime === null && ascii(bytes, 0, 5) === "%PDF-") {
    detectedMime = "application/pdf";
  } else if (
    detectedMime === null &&
    (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      startsWith(bytes, [0x50, 0x4b, 0x07, 0x08]))
  ) {
    detectedMime =
      extension === "apk" ? "application/vnd.android.package-archive" : "application/zip";
  } else if (
    detectedMime === null &&
    (ascii(bytes, 0, 7) === "Rar!\x1a\x07" || ascii(bytes, 0, 4) === "Rar!")
  ) {
    detectedMime = "application/vnd.rar";
  } else if (detectedMime === null && startsWith(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) {
    detectedMime = "application/x-7z-compressed";
  } else if (detectedMime === null && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    detectedMime = "application/vnd.microsoft.portable-executable";
  }

  detectedMime ??= "application/octet-stream";
  return {
    detectedMime,
    previewPolicy: INLINE_MIME_TYPES.has(detectedMime) ? "inline" : "download_only",
  };
}
