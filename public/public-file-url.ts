const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PREVIEW_PATH_PREFIX = "/temp-storage/objects/";

interface PublicFileUrlInput {
  readonly id: string;
  readonly previewPolicy: "inline" | "download_only";
  readonly previewUrl: string | null;
  readonly downloadUrl: string;
  readonly uploadOrigin: string;
  readonly cdnOrigin: string;
}

interface ValidatedPublicFileUrls {
  readonly previewUrl: string | null;
  readonly downloadUrl: string;
}

function parseTrustedOrigin(value: string): URL {
  const origin = new URL(value);
  const localHttp = origin.protocol === "http:" && LOCAL_HOSTNAMES.has(origin.hostname);
  if (
    (origin.protocol !== "https:" && !localHttp) ||
    origin.origin !== value ||
    origin.username !== "" ||
    origin.password !== ""
  ) {
    throw new Error("Invalid trusted origin.");
  }
  return origin;
}

function parseCandidateUrl(value: string, expectedOrigin: URL, label: string): URL {
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    throw new Error(`Invalid ${label} URL.`);
  }
  if (
    candidate.origin !== expectedOrigin.origin ||
    candidate.username !== "" ||
    candidate.password !== "" ||
    candidate.search !== "" ||
    candidate.hash !== ""
  ) {
    throw new Error(`Invalid ${label} URL.`);
  }
  return candidate;
}

export function validatePublicFileUrls(input: PublicFileUrlInput): ValidatedPublicFileUrls {
  const uploadOrigin = parseTrustedOrigin(input.uploadOrigin);
  const cdnOrigin = parseTrustedOrigin(input.cdnOrigin);
  const downloadUrl = parseCandidateUrl(input.downloadUrl, uploadOrigin, "download");
  if (downloadUrl.pathname !== `/d/${encodeURIComponent(input.id)}`) {
    throw new Error("Invalid download URL.");
  }

  if (input.previewPolicy === "download_only") {
    if (input.previewUrl !== null) {
      throw new Error("Invalid preview URL.");
    }
    return { previewUrl: null, downloadUrl: downloadUrl.href };
  }
  if (input.previewUrl === null) {
    throw new Error("Invalid preview URL.");
  }
  const previewUrl = parseCandidateUrl(input.previewUrl, cdnOrigin, "preview");
  if (
    !previewUrl.pathname.startsWith(PREVIEW_PATH_PREFIX) ||
    previewUrl.pathname.length === PREVIEW_PATH_PREFIX.length
  ) {
    throw new Error("Invalid preview URL.");
  }
  return { previewUrl: previewUrl.href, downloadUrl: downloadUrl.href };
}
