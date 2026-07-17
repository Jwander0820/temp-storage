const BLOCKED_EXTENSIONS = new Set([
  "html",
  "htm",
  "xhtml",
  "svg",
  "svgz",
  "js",
  "mjs",
  "cjs",
  "css",
  "xml",
  "xsl",
  "xslt",
  "wasm",
  "swf",
]);

export function getExtension(filename: string): string | null {
  const normalized = filename.trim();
  const lastDot = normalized.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === normalized.length - 1) {
    return null;
  }
  return normalized.slice(lastDot + 1).toLowerCase();
}

export function isBlockedExtension(extension: string | null): boolean {
  return extension !== null && BLOCKED_EXTENSIONS.has(extension);
}

export function sanitizeOriginalFilename(filename: string): string {
  const withoutControlCharacters = Array.from(filename.normalize("NFC"))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("");
  const normalized = withoutControlCharacters.replace(/[\\/]/gu, "_").trim();

  return normalized.slice(0, 255) || "download";
}

export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const safe = sanitizeOriginalFilename(filename)
    .replaceAll('"', "'")
    .replace(/[^\x20-\x7e]/gu, "_")
    .slice(0, 150);
  const encoded = encodeURIComponent(sanitizeOriginalFilename(filename)).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `${kind}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
