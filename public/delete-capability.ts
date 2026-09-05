const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const DELETE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DELETE_FRAGMENT_KEY = "token";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface DeleteCapability {
  readonly fileId: string;
  readonly deleteToken: string;
  readonly deleteUrl: string;
}

export interface DeleteCapabilityExport extends DeleteCapability {
  readonly filename: string;
}

function trustedOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    origin.origin !== value ||
    (origin.protocol !== "https:" &&
      !(origin.protocol === "http:" && LOCAL_HOSTNAMES.has(origin.hostname)))
  ) {
    throw new Error("Invalid upload origin.");
  }
  return origin;
}

export function createDeleteUrl(originValue: string, fileId: string, deleteToken: string): string {
  if (!FILE_ID_PATTERN.test(fileId) || !DELETE_TOKEN_PATTERN.test(deleteToken)) {
    throw new Error("Invalid delete capability.");
  }
  const origin = trustedOrigin(originValue);
  const url = new URL(`/delete/${encodeURIComponent(fileId)}`, origin);
  url.hash = new URLSearchParams({ [DELETE_FRAGMENT_KEY]: deleteToken }).toString();
  return url.href;
}

export function validateDeleteUrl(
  value: string,
  originValue: string,
  fileId: string,
  deleteToken: string,
): string {
  const expected = createDeleteUrl(originValue, fileId, deleteToken);
  if (value !== expected) {
    throw new Error("Invalid delete URL.");
  }
  return expected;
}

export function deleteTokenFromFragment(fragment: string): string | null {
  const token = new URLSearchParams(fragment.replace(/^#/u, "")).get(DELETE_FRAGMENT_KEY);
  return token !== null && DELETE_TOKEN_PATTERN.test(token) ? token : null;
}

function tsvCell(value: string): string {
  const flattened = value.replaceAll("\t", " ").replaceAll("\r", " ").replaceAll("\n", " ");
  return /^[=+\-@]/u.test(flattened) ? `'${flattened}` : flattened;
}

export function createDeleteCapabilityExport(items: readonly DeleteCapabilityExport[]): string {
  const rows = items.map((item) => `${tsvCell(item.filename)}\t${item.deleteUrl}`);
  return ["Jwander 暫存區刪除連結（僅此一份，請妥善保存）", "檔名\t刪除連結", ...rows, ""].join(
    "\r\n",
  );
}
