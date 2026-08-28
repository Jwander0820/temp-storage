const textEncoder = new TextEncoder();
const RANDOM_TOKEN_32_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/iu.test(value)) {
    return new Uint8Array(32);
  }

  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function createFileId(): string {
  return randomToken(16);
}

export function isFileId(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/u.test(value);
}

export function createDeleteToken(): string {
  return randomToken(32);
}

export function isRandomToken32(value: string): boolean {
  return RANDOM_TOKEN_32_PATTERN.test(value);
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashPepperedValue(pepper: string, value: string): Promise<string> {
  return sha256Hex(`${pepper}\u0000${value}`);
}

export async function verifyPepperedValue(
  pepper: string,
  provided: string,
  expectedHash: string,
): Promise<boolean> {
  const providedHash = await hashPepperedValue(pepper, provided);
  return crypto.subtle.timingSafeEqual(hexToBytes(providedHash), hexToBytes(expectedHash));
}

export async function timingSafeStringEqual(provided: string, expected: string): Promise<boolean> {
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", textEncoder.encode(provided)),
    crypto.subtle.digest("SHA-256", textEncoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}
