import { limitUploadBatch } from "./upload-limits";
import {
  createDeleteCapabilityExport,
  deleteTokenFromFragment,
  validateDeleteUrl,
} from "./delete-capability";
import { createDefaultInvitationLabel } from "./invitation-label";
import { createLatestRequestCoordinator } from "./latest-request";
import { validatePublicFileUrls } from "./public-file-url";
import QRCode from "qrcode";

interface PublicConfig {
  readonly maxFileBytes: number;
  readonly fileRetentionSeconds: number;
  readonly uploadsEnabled: boolean;
  readonly turnstileSiteKey: string;
  readonly accessCodeRequired: boolean;
  readonly maxFilesPerBatch: number;
  readonly maxParallelUploads: number;
  readonly sessionTtlSeconds: number;
  readonly uploadOrigin: string;
  readonly cdnOrigin: string;
}

interface StorageUsage {
  readonly usedBytes: number;
  readonly reservedBytes: number;
  readonly maxBytes: number;
  readonly availableBytes: number;
  readonly usageRatio: number;
}

interface InvitationSessionInfo {
  readonly authenticated: true;
  readonly label: string;
  readonly canUpload: boolean;
  readonly maxFiles: number;
  readonly unlimitedFiles: boolean;
  readonly maxBytes: number;
  readonly usedFiles: number;
  readonly usedBytes: number;
  readonly remainingFiles: number | null;
  readonly remainingBytes: number;
  readonly expiresAt: string;
  readonly sessionExpiresAt: string;
}

interface PublicFile {
  readonly id: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly detectedMime: string;
  readonly previewPolicy: "inline" | "download_only";
  readonly previewUrl: string | null;
  readonly downloadUrl: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface CompletedUpload extends PublicFile {
  readonly deleteToken: string;
  readonly deleteUrl: string;
}

interface Reservation {
  readonly uploadId: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

interface AdminInvitation {
  readonly id: string;
  readonly label: string;
  readonly status: "active" | "revoked" | "expired";
  readonly canUpload: boolean;
  readonly maxFiles: number;
  readonly unlimitedFiles: boolean;
  readonly maxBytes: number;
  readonly usedFiles: number;
  readonly usedBytes: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

interface CreatedInvitation {
  readonly id: string;
  readonly label: string;
  readonly inviteUrl: string;
  readonly canUpload: boolean;
  readonly maxFiles: number;
  readonly unlimitedFiles: boolean;
  readonly maxBytes: number;
  readonly expiresAt: string;
}

type FileTypeFilter = "all" | "image" | "video" | "audio" | "other";

interface FileListResponse {
  readonly files: PublicFile[];
  readonly nextCursor: string | null;
}

interface SessionCapabilities {
  readonly admin: boolean;
}

type TurnstileAction = "invite" | "admin";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: TurnstileAction;
      theme: "dark";
      size: "flexible";
      callback(token: string): void;
      "expired-callback"(): void;
      "error-callback"(): void;
    },
  ): string;
  reset(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

type UploadState = "queued" | "reserving" | "uploading" | "complete" | "failed" | "cancelled";

interface UploadTask {
  readonly id: string;
  readonly file: File;
  state: UploadState;
  progress: number;
  message: string;
  cancelled: boolean;
  readonly abortController: AbortController;
  xhr: XMLHttpRequest | null;
  result: CompletedUpload | null;
}

const tasks: UploadTask[] = [];
let activeUploads = 0;
let config: PublicConfig | null = null;
let sharedFiles: PublicFile[] = [];
let sharedFilesCursor: string | null = null;
let sharedFilesType: FileTypeFilter = "all";
const sharedFilesRequests = createLatestRequestCoordinator();
let adminSessionActive = false;
let pendingAdminDelete: { file: PublicFile; trigger: HTMLButtonElement } | null = null;
let adminInvitations: AdminInvitation[] = [];
let activeInvitationPage = 0;
let invitationHistoryPage = 0;
const invitationsPerPage = 4;

function elementById<T extends HTMLElement>(
  id: string,
  constructor: abstract new (...arguments_: never[]) => T,
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(`Missing required element #${id}.`);
  }
  return element;
}

const uploadPage = elementById("uploadPage", HTMLElement);
const filesPage = elementById("filesPage", HTMLElement);
const adminPage = elementById("adminPage", HTMLElement);
const filePage = elementById("filePage", HTMLElement);
const filesInviteGate = elementById("filesInviteGate", HTMLElement);
const filesWorkspace = elementById("filesWorkspace", HTMLElement);
const adminFilesNotice = elementById("adminFilesNotice", HTMLElement);
const fileTypeFilters = elementById("fileTypeFilters", HTMLElement);
const sharedFilesStatus = elementById("sharedFilesStatus", HTMLElement);
const sharedFileList = elementById("sharedFileList", HTMLElement);
const retrySharedFilesButton = elementById("retrySharedFilesButton", HTMLButtonElement);
const loadMoreSharedFilesButton = elementById("loadMoreSharedFilesButton", HTMLButtonElement);
const inviteGate = elementById("inviteGate", HTMLElement);
const inviteGateTitle = elementById("inviteGateTitle", HTMLElement);
const inviteGateMessage = elementById("inviteGateMessage", HTMLElement);
const inviteVerification = elementById("inviteVerification", HTMLElement);
const verifyInviteButton = elementById("verifyInviteButton", HTMLButtonElement);
const uploadWorkspace = elementById("uploadWorkspace", HTMLElement);
const invitationLabel = elementById("invitationLabel", HTMLElement);
const invitationRemaining = elementById("invitationRemaining", HTMLElement);
const capacityText = elementById("capacityText", HTMLElement);
const capacityStatus = elementById("capacityStatus", HTMLElement);
const capacityTrack = elementById("capacityTrack", HTMLElement);
const capacityFill = elementById("capacityFill", HTMLElement);
const capacityRemaining = elementById("capacityRemaining", HTMLElement);
const dropZone = elementById("dropZone", HTMLElement);
const fileInput = elementById("fileInput", HTMLInputElement);
const chooseButton = elementById("chooseButton", HTMLButtonElement);
const accessCodeField = elementById("accessCodeField", HTMLElement);
const accessCodeInput = elementById("accessCodeInput", HTMLInputElement);
const turnstileContainer = elementById("turnstileContainer", HTMLElement);
const adminGate = elementById("adminGate", HTMLElement);
const adminGateMessage = elementById("adminGateMessage", HTMLElement);
const adminTokenInput = elementById("adminTokenInput", HTMLInputElement);
const adminTurnstileContainer = elementById("adminTurnstileContainer", HTMLElement);
const adminLoginButton = elementById("adminLoginButton", HTMLButtonElement);
const adminWorkspace = elementById("adminWorkspace", HTMLElement);
const revokeAllAdminSessionsButton = elementById("revokeAllAdminSessionsButton", HTMLButtonElement);
const inviteForm = elementById("inviteForm", HTMLFormElement);
const inviteLabelInput = elementById("inviteLabelInput", HTMLInputElement);
const inviteDaysInput = elementById("inviteDaysInput", HTMLInputElement);
const inviteFilesInput = elementById("inviteFilesInput", HTMLInputElement);
const inviteUnlimitedFilesInput = elementById("inviteUnlimitedFilesInput", HTMLInputElement);
const inviteMbInput = elementById("inviteMbInput", HTMLInputElement);
const inviteUploadModeInput = elementById("inviteUploadModeInput", HTMLInputElement);
const inviteBrowseModeInput = elementById("inviteBrowseModeInput", HTMLInputElement);
const createInviteButton = elementById("createInviteButton", HTMLButtonElement);
const createdInvite = elementById("createdInvite", HTMLElement);
const createdInviteLabel = elementById("createdInviteLabel", HTMLElement);
const createdInviteUrl = elementById("createdInviteUrl", HTMLInputElement);
const copyInviteButton = elementById("copyInviteButton", HTMLButtonElement);
const showQrButton = elementById("showQrButton", HTMLButtonElement);
const refreshInvitationsButton = elementById("refreshInvitationsButton", HTMLButtonElement);
const activeInvitationList = elementById("activeInvitationList", HTMLElement);
const invitationHistoryList = elementById("invitationHistoryList", HTMLElement);
const activeInvitationCount = elementById("activeInvitationCount", HTMLElement);
const invitationHistoryCount = elementById("invitationHistoryCount", HTMLElement);
const activeInvitationPagination = elementById("activeInvitationPagination", HTMLElement);
const activeInvitationPrevious = elementById("activeInvitationPrevious", HTMLButtonElement);
const activeInvitationNext = elementById("activeInvitationNext", HTMLButtonElement);
const activeInvitationPageStatus = elementById("activeInvitationPageStatus", HTMLElement);
const invitationHistoryPagination = elementById("invitationHistoryPagination", HTMLElement);
const invitationHistoryPrevious = elementById("invitationHistoryPrevious", HTMLButtonElement);
const invitationHistoryNext = elementById("invitationHistoryNext", HTMLButtonElement);
const invitationHistoryPageStatus = elementById("invitationHistoryPageStatus", HTMLElement);
const qrDialog = elementById("qrDialog", HTMLDialogElement);
const qrImage = elementById("qrImage", HTMLImageElement);
const qrInviteLabel = elementById("qrInviteLabel", HTMLElement);
const closeQrButton = elementById("closeQrButton", HTMLButtonElement);
const deleteFileDialog = elementById("deleteFileDialog", HTMLDialogElement);
const deleteFileMessage = elementById("deleteFileMessage", HTMLElement);
const cancelDeleteFileButton = elementById("cancelDeleteFileButton", HTMLButtonElement);
const confirmDeleteFileButton = elementById("confirmDeleteFileButton", HTMLButtonElement);
const uploadQueue = elementById("uploadQueue", HTMLOListElement);
const queueCount = elementById("queueCount", HTMLElement);
const deleteCapabilityNotice = elementById("deleteCapabilityNotice", HTMLElement);
const deleteCapabilityCount = elementById("deleteCapabilityCount", HTMLElement);
const downloadDeleteLinksButton = elementById("downloadDeleteLinksButton", HTMLButtonElement);
const uploadHelp = elementById("upload-help", HTMLElement);
const toastRegion = elementById("toastRegion", HTMLElement);
const themeToggle = elementById("themeToggle", HTMLButtonElement);
const globalUploadLink = elementById("globalUploadLink", HTMLAnchorElement);
const globalFilesLink = elementById("globalFilesLink", HTMLAnchorElement);
const globalPrimaryLabel = elementById("globalPrimaryLabel", HTMLElement);

type ColorTheme = "light" | "dark";

let savedTheme: ColorTheme | null = null;

try {
  const storedTheme = window.localStorage.getItem("jwander-color-theme");
  if (storedTheme === "light" || storedTheme === "dark") {
    savedTheme = storedTheme;
  }
} catch {
  // Storage may be unavailable in privacy-restricted browsing contexts.
}

function applyTheme(theme: ColorTheme, persist: boolean): void {
  document.documentElement.dataset.theme = theme;
  themeToggle.setAttribute("aria-pressed", String(theme === "dark"));
  themeToggle.setAttribute("aria-label", theme === "dark" ? "切換亮色模式" : "切換深色模式");
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#191b18" : "#f3f2ed");

  if (!persist) {
    return;
  }
  savedTheme = theme;
  try {
    window.localStorage.setItem("jwander-color-theme", theme);
  } catch {
    // The visual preference still applies for the current page.
  }
}

applyTheme(savedTheme ?? "light", false);

themeToggle.addEventListener("click", () => {
  const nextTheme: ColorTheme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(nextTheme, true);
});

function setNavigationMode(adminMode: boolean): void {
  const isAdminPath =
    window.location.pathname === "/admin" || window.location.pathname === "/admin/";
  const isFiles =
    window.location.pathname === "/files" ||
    window.location.pathname === "/files/" ||
    window.location.pathname.startsWith("/file/");
  const showAdminNavigation = adminMode || isAdminPath;
  globalUploadLink.href = showAdminNavigation ? "/admin" : "/";
  globalPrimaryLabel.textContent = showAdminNavigation ? "管理" : "上傳";
  document.body.classList.toggle("has-admin-session", showAdminNavigation);
  for (const [link, current] of [
    [globalUploadLink, showAdminNavigation ? isAdminPath : !isFiles],
    [globalFilesLink, isFiles],
  ] as const) {
    link.classList.toggle("is-current", current);
    if (current) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }
}

setNavigationMode(false);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Invalid ${key} response.`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid ${key} response.`);
  }
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Invalid ${key} response.`);
  }
  return value;
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`Invalid ${key}.`);
  }
  return value;
}

function requiredNullableNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (value === null) {
    return null;
  }
  return requiredNumber(record, key);
}

function parseConfig(value: unknown): PublicConfig {
  if (!isRecord(value)) {
    throw new Error("Invalid configuration response.");
  }
  return {
    maxFileBytes: requiredNumber(value, "maxFileBytes"),
    fileRetentionSeconds: requiredNumber(value, "fileRetentionSeconds"),
    uploadsEnabled: requiredBoolean(value, "uploadsEnabled"),
    turnstileSiteKey: requiredString(value, "turnstileSiteKey"),
    accessCodeRequired: requiredBoolean(value, "accessCodeRequired"),
    maxFilesPerBatch: requiredNumber(value, "maxFilesPerBatch"),
    maxParallelUploads: requiredNumber(value, "maxParallelUploads"),
    sessionTtlSeconds: requiredNumber(value, "sessionTtlSeconds"),
    uploadOrigin: requiredString(value, "uploadOrigin"),
    cdnOrigin: requiredString(value, "cdnOrigin"),
  };
}

function parseStorage(value: unknown): StorageUsage {
  if (!isRecord(value)) {
    throw new Error("Invalid storage response.");
  }
  return {
    usedBytes: requiredNumber(value, "usedBytes"),
    reservedBytes: requiredNumber(value, "reservedBytes"),
    maxBytes: requiredNumber(value, "maxBytes"),
    availableBytes: requiredNumber(value, "availableBytes"),
    usageRatio: requiredNumber(value, "usageRatio"),
  };
}

function parseInvitationSession(value: unknown): InvitationSessionInfo {
  if (!isRecord(value) || value.authenticated !== true) {
    throw new Error("Invalid invitation session response.");
  }
  return {
    authenticated: true,
    label: requiredString(value, "label"),
    canUpload: requiredBoolean(value, "canUpload"),
    maxFiles: requiredNumber(value, "maxFiles"),
    unlimitedFiles: requiredBoolean(value, "unlimitedFiles"),
    maxBytes: requiredNumber(value, "maxBytes"),
    usedFiles: requiredNumber(value, "usedFiles"),
    usedBytes: requiredNumber(value, "usedBytes"),
    remainingFiles: requiredNullableNumber(value, "remainingFiles"),
    remainingBytes: requiredNumber(value, "remainingBytes"),
    expiresAt: requiredString(value, "expiresAt"),
    sessionExpiresAt: requiredString(value, "sessionExpiresAt"),
  };
}

function parsePublicFile(value: unknown): PublicFile {
  if (!isRecord(value)) {
    throw new Error("Invalid file response.");
  }
  const previewPolicy = value.previewPolicy;
  const previewUrl = value.previewUrl;
  if (
    (previewPolicy !== "inline" && previewPolicy !== "download_only") ||
    (previewUrl !== null && typeof previewUrl !== "string")
  ) {
    throw new Error("Invalid preview response.");
  }
  const id = requiredString(value, "id");
  if (config === null) {
    throw new Error("File URL policy is unavailable.");
  }
  const urls = validatePublicFileUrls({
    id,
    previewPolicy,
    previewUrl,
    downloadUrl: requiredString(value, "downloadUrl"),
    uploadOrigin: config.uploadOrigin,
    cdnOrigin: config.cdnOrigin,
  });
  return {
    id,
    filename: requiredString(value, "filename"),
    sizeBytes: requiredNumber(value, "sizeBytes"),
    detectedMime: requiredString(value, "detectedMime"),
    previewPolicy,
    previewUrl: urls.previewUrl,
    downloadUrl: urls.downloadUrl,
    createdAt: requiredString(value, "createdAt"),
    expiresAt: requiredString(value, "expiresAt"),
  };
}

function parseFileList(value: unknown): FileListResponse {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    throw new Error("Invalid file list response.");
  }
  return {
    files: value.files.map(parsePublicFile),
    nextCursor: nullableString(value, "nextCursor"),
  };
}

function parseSessionCapabilities(value: unknown): SessionCapabilities {
  if (!isRecord(value) || typeof value.admin !== "boolean") {
    throw new Error("Invalid session capabilities response.");
  }
  return { admin: value.admin };
}

function parseCompletedUpload(value: unknown): CompletedUpload {
  if (!isRecord(value) || config === null) {
    throw new Error("Invalid upload response.");
  }
  const file = parsePublicFile(value);
  const deleteToken = requiredString(value, "deleteToken");
  return {
    ...file,
    deleteToken,
    deleteUrl: validateDeleteUrl(
      requiredString(value, "deleteUrl"),
      config.uploadOrigin,
      file.id,
      deleteToken,
    ),
  };
}

function parseReservation(value: unknown): Reservation {
  if (!isRecord(value)) {
    throw new Error("Invalid reservation response.");
  }
  return {
    uploadId: requiredString(value, "uploadId"),
    uploadUrl: requiredString(value, "uploadUrl"),
    expiresAt: requiredString(value, "expiresAt"),
  };
}

function parseAdminInvitation(value: unknown): AdminInvitation {
  if (!isRecord(value)) {
    throw new Error("Invalid invitation response.");
  }
  const status = value.status;
  if (status !== "active" && status !== "revoked" && status !== "expired") {
    throw new Error("Invalid invitation status.");
  }
  return {
    id: requiredString(value, "id"),
    label: requiredString(value, "label"),
    status,
    canUpload: requiredBoolean(value, "canUpload"),
    maxFiles: requiredNumber(value, "maxFiles"),
    unlimitedFiles: requiredBoolean(value, "unlimitedFiles"),
    maxBytes: requiredNumber(value, "maxBytes"),
    usedFiles: requiredNumber(value, "usedFiles"),
    usedBytes: requiredNumber(value, "usedBytes"),
    createdAt: requiredString(value, "createdAt"),
    expiresAt: requiredString(value, "expiresAt"),
    revokedAt: nullableString(value, "revokedAt"),
  };
}

function parseCreatedInvitation(value: unknown): CreatedInvitation {
  if (!isRecord(value)) {
    throw new Error("Invalid invitation response.");
  }
  return {
    id: requiredString(value, "id"),
    label: requiredString(value, "label"),
    inviteUrl: requiredString(value, "inviteUrl"),
    canUpload: requiredBoolean(value, "canUpload"),
    maxFiles: requiredNumber(value, "maxFiles"),
    unlimitedFiles: requiredBoolean(value, "unlimitedFiles"),
    maxBytes: requiredNumber(value, "maxBytes"),
    expiresAt: requiredString(value, "expiresAt"),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400} 天`;
  }
  if (seconds % 3_600 === 0) {
    return `${seconds / 3_600} 小時`;
  }
  return `${Math.max(1, Math.round(seconds / 60))} 分鐘`;
}

function formatRemaining(expiresAt: string): string {
  const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  if (seconds < 60) {
    return "即將到期";
  }
  if (seconds < 3_600) {
    return `剩餘 ${Math.ceil(seconds / 60)} 分鐘`;
  }
  if (seconds < 86_400) {
    return `剩餘 ${Math.ceil(seconds / 3_600)} 小時`;
  }
  return `剩餘 ${Math.ceil(seconds / 86_400)} 天`;
}

function showToast(message: string, kind: "success" | "error" = "success"): void {
  const toast = document.createElement("div");
  toast.className = `toast toast--${kind}`;
  toast.textContent = message;
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), 3600);
}

async function responseError(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
      return payload.error.message;
    }
  } catch {
    // Fall back to a status-based message.
  }
  return `請求失敗（HTTP ${response.status}）`;
}

const ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE = "管理員驗證已失效，請重新進入管理頁完成驗證。";

class AdminAuthenticationUnavailableError extends Error {
  constructor() {
    super(ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE);
    this.name = "AdminAuthenticationUnavailableError";
  }
}

function isAdminAuthenticationUnavailable(response: Response): boolean {
  const contentType = response.headers.get("Content-Type") ?? "";
  return (
    response.status === 401 ||
    response.status === 403 ||
    response.redirected ||
    contentType.includes("text/html")
  );
}

async function requireAdminNoContent(response: Response): Promise<void> {
  if (isAdminAuthenticationUnavailable(response)) {
    throw new AdminAuthenticationUnavailableError();
  }
  if (response.status !== 204) {
    throw new Error(await responseError(response));
  }
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const fallback = document.createElement("textarea");
    fallback.value = value;
    fallback.setAttribute("readonly", "");
    fallback.className = "clipboard-fallback";
    document.body.append(fallback);
    fallback.select();
    document.execCommand("copy");
    fallback.remove();
  }
  showToast("已複製到剪貼簿");
}

function fileKind(file: PublicFile): { label: string; code: string; className: string } {
  if (file.detectedMime.startsWith("image/")) {
    return { label: "圖片", code: "IMG", className: "image" };
  }
  if (file.detectedMime.startsWith("video/")) {
    return { label: "影片", code: "VID", className: "video" };
  }
  if (file.detectedMime.startsWith("audio/")) {
    return { label: "音訊", code: "AUD", className: "audio" };
  }
  return { label: "檔案", code: "FILE", className: "other" };
}

function createFileVisual(file: PublicFile): HTMLElement {
  const kind = fileKind(file);
  const visual = document.createElement("div");
  visual.className = `file-card__visual file-card__visual--${kind.className}`;

  if (kind.className === "image" && file.previewPolicy === "inline" && file.previewUrl !== null) {
    const image = document.createElement("img");
    image.src = file.previewUrl;
    image.alt = file.filename;
    image.loading = "lazy";
    image.decoding = "async";
    visual.append(image);
    return visual;
  }

  const code = document.createElement("span");
  code.className = "file-card__kind";
  code.textContent = kind.code;
  const signal = document.createElement("span");
  signal.className = "file-card__signal";
  signal.setAttribute("aria-hidden", "true");
  signal.append(
    document.createElement("i"),
    document.createElement("i"),
    document.createElement("i"),
  );
  visual.append(code, signal);
  return visual;
}

function publicFilePageUrl(file: PublicFile): string {
  return new URL(`/file/${encodeURIComponent(file.id)}`, window.location.origin).href;
}

function createSharedFileCard(file: PublicFile): HTMLElement {
  const card = document.createElement("article");
  card.className = "file-card";

  const visualLink = document.createElement("a");
  visualLink.href = `/file/${encodeURIComponent(file.id)}`;
  visualLink.className = "file-card__visual-link";
  visualLink.setAttribute("aria-label", `開啟 ${file.filename}`);
  visualLink.append(createFileVisual(file));

  const body = document.createElement("div");
  body.className = "file-card__body";
  const heading = document.createElement("h2");
  const fileLink = document.createElement("a");
  fileLink.href = `/file/${encodeURIComponent(file.id)}`;
  fileLink.textContent = file.filename;
  heading.append(fileLink);

  const type = document.createElement("p");
  type.className = "file-card__type";
  type.textContent = `${fileKind(file).label} · ${file.detectedMime}`;

  const details = document.createElement("dl");
  details.className = "file-card__details";
  addDetail(details, "大小", formatBytes(file.sizeBytes));
  addDetail(details, "上傳", formatDate(file.createdAt));
  addDetail(details, "到期", `${formatDate(file.expiresAt)}（${formatRemaining(file.expiresAt)}）`);

  const actions = document.createElement("div");
  actions.className = "file-card__actions";
  const download = document.createElement("a");
  download.href = file.downloadUrl;
  download.className = "secondary-button secondary-button--link";
  download.textContent = "下載";
  const copy = createActionButton("複製連結", () => {
    void copyText(publicFilePageUrl(file));
  });
  actions.append(download, copy);
  if (adminSessionActive) {
    card.classList.add("file-card--admin");
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "secondary-button danger-button";
    deleteButton.textContent = "刪除";
    deleteButton.addEventListener("click", () => requestAdminFileDeletion(file, deleteButton));
    actions.append(deleteButton);
  }
  body.append(heading, type, details, actions);
  card.append(visualLink, body);
  return card;
}

function renderSharedFiles(): void {
  sharedFileList.replaceChildren(...sharedFiles.map(createSharedFileCard));
  if (sharedFiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "browser-empty";
    const heading = document.createElement("h2");
    heading.textContent = "暫存區目前沒有可瀏覽的檔案";
    const message = document.createElement("p");
    message.textContent =
      sharedFilesType === "all" ? "有檔案上傳完成後，會顯示在這裡。" : "這個類型目前沒有有效檔案。";
    empty.append(heading, message);
    sharedFileList.append(empty);
  }
  sharedFilesStatus.textContent = `已顯示 ${sharedFiles.length} 個檔案`;
  loadMoreSharedFilesButton.classList.toggle("is-hidden", sharedFilesCursor === null);
}

async function loadSharedFiles(reset: boolean): Promise<void> {
  const request = sharedFilesRequests.begin();
  const requestedType = sharedFilesType;
  const requestedCursor = reset ? null : sharedFilesCursor;
  retrySharedFilesButton.classList.add("is-hidden");
  loadMoreSharedFilesButton.disabled = true;
  sharedFilesStatus.textContent = reset ? "正在讀取共享檔案。" : "正在載入更多檔案。";
  const parameters = new URLSearchParams({ limit: "24", type: requestedType });
  if (requestedCursor !== null) {
    parameters.set("cursor", requestedCursor);
  }
  try {
    const response = await fetch(`/api/files?${parameters.toString()}`, {
      cache: "no-store",
      signal: request.signal,
    });
    if (!request.isCurrent()) {
      return;
    }
    if (response.status === 401) {
      filesWorkspace.classList.add("is-hidden");
      filesInviteGate.classList.remove("is-hidden");
      return;
    }
    if (!response.ok) {
      throw new Error(await responseError(response));
    }
    const payload = parseFileList(await response.json());
    if (!request.isCurrent()) {
      return;
    }
    sharedFiles = reset ? payload.files : [...sharedFiles, ...payload.files];
    sharedFilesCursor = payload.nextCursor;
    renderSharedFiles();
  } catch (error) {
    if (request.signal.aborted || !request.isCurrent()) {
      return;
    }
    throw error;
  } finally {
    if (request.isCurrent()) {
      loadMoreSharedFilesButton.disabled = false;
    }
    request.finish();
  }
}

async function initializeFilesPage(): Promise<void> {
  uploadPage.classList.add("is-hidden");
  adminPage.classList.add("is-hidden");
  filePage.classList.add("is-hidden");
  filesPage.classList.remove("is-hidden");
  filesWorkspace.classList.remove("is-hidden");
  await loadConfig();
  adminSessionActive = await hasAdminCapability().catch(() => false);
  setNavigationMode(adminSessionActive);
  adminFilesNotice.classList.toggle("is-hidden", !adminSessionActive);
  try {
    await loadSharedFiles(true);
  } catch (error) {
    sharedFilesStatus.textContent =
      error instanceof Error ? error.message : "無法讀取共享檔案，請稍後再試。";
    retrySharedFilesButton.classList.remove("is-hidden");
    loadMoreSharedFilesButton.disabled = false;
  }
}

class TurnstileTokenManager {
  private widgetId: string | null = null;
  private token: string | null = null;
  private readonly waiters: Array<{
    resolve(token: string): void;
    reject(error: Error): void;
  }> = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly action: TurnstileAction,
  ) {}

  async initialize(siteKey: string): Promise<void> {
    if (siteKey.length === 0 || siteKey.startsWith("replace-with-")) {
      this.container.textContent = "安全驗證尚未完成設定，功能暫停。";
      this.container.classList.add("turnstile-slot--error");
      return;
    }

    await this.loadScript();
    const api = window.turnstile;
    if (api === undefined) {
      throw new Error("安全驗證載入失敗。");
    }

    this.widgetId = api.render(this.container, {
      sitekey: siteKey,
      action: this.action,
      theme: "dark",
      size: "flexible",
      callback: (token) => this.acceptToken(token),
      "expired-callback": () => {
        this.refresh();
      },
      "error-callback": () => {
        this.rejectWaiters(new Error("安全驗證失敗，請重新整理後再試。"));
      },
    });
  }

  async takeToken(signal: AbortSignal): Promise<string> {
    if (signal.aborted) {
      throw new DOMException("Operation aborted.", "AbortError");
    }
    if (this.widgetId === null) {
      throw new Error("安全驗證尚未完成設定。");
    }
    if (this.token !== null) {
      const token = this.token;
      this.token = null;
      return token;
    }
    return new Promise<string>((resolve, reject) => {
      const waiter = {
        resolve: (token: string): void => {
          signal.removeEventListener("abort", abort);
          resolve(token);
        },
        reject: (error: Error): void => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      };
      const abort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new DOMException("Operation aborted.", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private acceptToken(token: string): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.token = token;
      return;
    }
    waiter.resolve(token);
  }

  refresh(): void {
    this.token = null;
    const widgetId = this.widgetId;
    if (widgetId !== null) {
      window.setTimeout(() => window.turnstile?.reset(widgetId), 0);
    }
  }

  private rejectWaiters(error: Error): void {
    this.token = null;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  private loadScript(): Promise<void> {
    if (window.turnstile !== undefined) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("無法載入安全驗證。")), {
        once: true,
      });
      document.head.append(script);
    });
  }
}

const turnstile = new TurnstileTokenManager(turnstileContainer, "invite");
const adminTurnstile = new TurnstileTokenManager(adminTurnstileContainer, "admin");

function stateLabel(task: UploadTask): string {
  switch (task.state) {
    case "queued":
      return "等待中";
    case "reserving":
      return "保留容量";
    case "uploading":
      return `上傳中 ${task.progress}%`;
    case "complete":
      return "完成";
    case "failed":
      return "失敗";
    case "cancelled":
      return "已取消";
  }
}

function createActionButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function renderQueue(): void {
  const completed = tasks.flatMap((task) => (task.result === null ? [] : [task.result]));
  deleteCapabilityNotice.classList.toggle("is-hidden", completed.length === 0);
  deleteCapabilityCount.textContent = `目前有 ${completed.length} 個刪除連結可匯出`;
  queueCount.textContent = `${tasks.length} 個檔案`;
  uploadQueue.replaceChildren();
  if (tasks.length === 0) {
    const empty = document.createElement("li");
    empty.className = "queue__empty";
    empty.textContent = "尚未加入檔案。";
    uploadQueue.append(empty);
    return;
  }

  for (const task of tasks) {
    const item = document.createElement("li");
    item.className = `upload-item upload-item--${task.state}`;

    const main = document.createElement("div");
    main.className = "upload-item__main";
    const heading = document.createElement("div");
    heading.className = "upload-item__heading";
    const name = document.createElement("strong");
    name.textContent = task.file.name;
    name.title = task.file.name;
    const size = document.createElement("span");
    size.textContent = formatBytes(task.file.size);
    heading.append(name, size);

    const status = document.createElement("p");
    status.className = "upload-item__status";
    status.textContent = task.message || stateLabel(task);
    main.append(heading, status);

    const progress = document.createElement("div");
    progress.className = "upload-progress";
    progress.setAttribute("aria-label", `${task.file.name} 上傳進度`);
    const progressFill = document.createElement("span");
    progressFill.style.width = `${task.progress}%`;
    progress.append(progressFill);
    main.append(progress);

    const actions = document.createElement("div");
    actions.className = "upload-item__actions";
    if (task.state === "queued" || task.state === "reserving") {
      actions.append(createActionButton("取消", () => cancelTask(task)));
    } else if (task.state === "uploading") {
      actions.append(createActionButton("中止上傳", () => cancelTask(task)));
    } else if (task.state === "failed" || task.state === "cancelled") {
      actions.append(createActionButton("移除", () => removeTask(task)));
    } else if (task.result !== null) {
      const result = task.result;
      actions.append(
        createActionButton("資訊頁", () => {
          window.open(`/file/${encodeURIComponent(result.id)}`, "_blank", "noopener");
        }),
        createActionButton("複製下載連結", () => {
          void copyText(result.downloadUrl);
        }),
        createActionButton("複製刪除連結", () => {
          void copyText(result.deleteUrl);
        }),
      );
      if (result.previewUrl !== null) {
        actions.append(
          createActionButton("複製預覽連結", () => {
            void copyText(result.previewUrl ?? result.downloadUrl);
          }),
          createActionButton("複製 Markdown", () => {
            void copyText(`![${result.filename}](${result.previewUrl ?? result.downloadUrl})`);
          }),
        );
      }
      actions.append(
        createActionButton("刪除", () => {
          void deleteUploadedFile(task);
        }),
      );
    }

    item.append(main, actions);
    uploadQueue.append(item);
  }
}

function downloadDeleteLinks(): void {
  const completed = tasks.flatMap((task) =>
    task.result === null
      ? []
      : [
          {
            filename: task.result.filename,
            fileId: task.result.id,
            deleteToken: task.result.deleteToken,
            deleteUrl: task.result.deleteUrl,
          },
        ],
  );
  if (completed.length === 0) {
    showToast("目前沒有可匯出的刪除連結。", "error");
    return;
  }

  const blob = new Blob([createDeleteCapabilityExport(completed)], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `jwander-delete-links-${new Date().toISOString().replaceAll(":", "-")}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast(`已匯出 ${completed.length} 個刪除連結`);
}

function cancelTask(task: UploadTask): void {
  task.cancelled = true;
  task.abortController.abort();
  task.xhr?.abort();
  task.state = "cancelled";
  task.message = "已取消；若容量已保留，伺服器會自動回收。";
  renderQueue();
}

function removeTask(task: UploadTask): void {
  const index = tasks.indexOf(task);
  if (index >= 0) {
    tasks.splice(index, 1);
  }
  renderQueue();
}

async function deleteUploadedFile(task: UploadTask): Promise<void> {
  if (task.result === null) {
    return;
  }
  const response = await fetch(`/api/files/${encodeURIComponent(task.result.id)}`, {
    method: "DELETE",
    headers: { Authorization: `DeleteToken ${task.result.deleteToken}` },
  });
  if (!response.ok && response.status !== 204) {
    showToast(await responseError(response), "error");
    return;
  }
  showToast("檔案已刪除");
  removeTask(task);
  await loadStorage();
}

function enqueueFiles(files: Iterable<File>): void {
  if (config === null || !config.uploadsEnabled) {
    showToast("目前未開放上傳。", "error");
    return;
  }

  const batch = limitUploadBatch(files, config.maxFilesPerBatch);
  if (batch.omittedCount > 0) {
    showToast(
      `單次最多上傳 ${config.maxFilesPerBatch} 個檔案；已略過其餘 ${batch.omittedCount} 個。`,
      "error",
    );
  }

  for (const file of batch.files) {
    if (file.size === 0) {
      showToast(`${file.name} 是空檔案，已略過。`, "error");
      continue;
    }
    if (file.size > config.maxFileBytes) {
      showToast(`${file.name} 超過 ${formatBytes(config.maxFileBytes)} 上限。`, "error");
      continue;
    }
    tasks.push({
      id: crypto.randomUUID(),
      file,
      state: "queued",
      progress: 0,
      message: "",
      cancelled: false,
      abortController: new AbortController(),
      xhr: null,
      result: null,
    });
  }
  renderQueue();
  pumpQueue();
}

function pumpQueue(): void {
  const maximumParallelUploads = config?.maxParallelUploads ?? 1;
  while (activeUploads < maximumParallelUploads) {
    const task = tasks.find((candidate) => candidate.state === "queued" && !candidate.cancelled);
    if (task === undefined) {
      return;
    }
    activeUploads += 1;
    task.state = "reserving";
    task.message = "正在檢查配額與保留空間。";
    renderQueue();
    void processTask(task).finally(() => {
      activeUploads -= 1;
      renderQueue();
      pumpQueue();
    });
  }
}

async function processTask(task: UploadTask): Promise<void> {
  try {
    const reserveResponse = await fetch("/api/uploads/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: task.abortController.signal,
      body: JSON.stringify({
        filename: task.file.name,
        sizeBytes: task.file.size,
        declaredMime: task.file.type || null,
      }),
    });
    if (!reserveResponse.ok) {
      throw new Error(await responseError(reserveResponse));
    }
    const reservationPayload: unknown = await reserveResponse.json();
    const reservation = parseReservation(reservationPayload);
    if (task.cancelled) {
      return;
    }

    task.state = "uploading";
    task.message = "正在上傳檔案。";
    renderQueue();
    const result = await uploadWithProgress(task, reservation);
    task.result = result;
    task.progress = 100;
    task.state = "complete";
    task.message = `完成；將於 ${formatDate(result.expiresAt)} 到期。`;
    showToast(`${task.file.name} 上傳完成`);
    await loadStorage();
  } catch (error) {
    if (task.cancelled) {
      task.state = "cancelled";
      return;
    }
    task.state = "failed";
    task.message = error instanceof Error ? error.message : "上傳失敗。";
    showToast(`${task.file.name}：${task.message}`, "error");
  } finally {
    task.xhr = null;
  }
}

function uploadWithProgress(task: UploadTask, reservation: Reservation): Promise<CompletedUpload> {
  return new Promise<CompletedUpload>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    task.xhr = xhr;
    xhr.open("PUT", reservation.uploadUrl);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) {
        return;
      }
      task.progress = Math.min(99, Math.round((event.loaded / event.total) * 100));
      task.message = stateLabel(task);
      renderQueue();
    });
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        try {
          const payload: unknown = JSON.parse(xhr.responseText);
          if (
            isRecord(payload) &&
            isRecord(payload.error) &&
            typeof payload.error.message === "string"
          ) {
            reject(new Error(payload.error.message));
            return;
          }
        } catch {
          // Fall through to the HTTP status message.
        }
        reject(new Error(`上傳失敗（HTTP ${xhr.status}）`));
        return;
      }
      try {
        const payload: unknown = JSON.parse(xhr.responseText);
        resolve(parseCompletedUpload(payload));
      } catch {
        reject(new Error("伺服器回傳了無法解析的上傳結果。"));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("網路連線中斷。")));
    xhr.addEventListener("abort", () => reject(new Error("上傳已取消。")));
    xhr.send(task.file);
  });
}

async function loadStorage(): Promise<void> {
  try {
    const response = await fetch("/api/storage");
    if (!response.ok) {
      throw new Error(await responseError(response));
    }
    const payload: unknown = await response.json();
    const storage = parseStorage(payload);
    const percentage = Math.round(storage.usageRatio * 1000) / 10;
    capacityText.textContent = `${formatBytes(storage.usedBytes)} / ${formatBytes(storage.maxBytes)}`;
    const capacityLabel =
      percentage >= 95 ? "容量幾乎已滿" : percentage >= 80 ? "接近上限" : "容量正常";
    capacityStatus.textContent = `${capacityLabel} · ${percentage}%`;
    capacityRemaining.textContent =
      `剩餘 ${formatBytes(storage.availableBytes)}；` +
      `另有 ${formatBytes(storage.reservedBytes)} 正在上傳或等待。`;
    capacityFill.style.width = `${Math.min(100, percentage)}%`;
    capacityTrack.setAttribute("aria-valuenow", String(Math.round(percentage)));
  } catch (error) {
    capacityText.textContent = "容量資訊無法讀取";
    capacityStatus.textContent = "離線";
    capacityRemaining.textContent = error instanceof Error ? error.message : "請稍後重新整理頁面。";
  }
}

async function loadConfig(): Promise<void> {
  const response = await fetch("/api/config");
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  const payload: unknown = await response.json();
  config = parseConfig(payload);
  uploadHelp.textContent =
    `單次最多加入 ${config.maxFilesPerBatch} 個檔案、` +
    `單一檔案上限 ${formatBytes(config.maxFileBytes)}。` +
    "完成後可直接複製分享或下載連結。";
  if (!config.uploadsEnabled) {
    dropZone.classList.add("is-disabled");
    chooseButton.disabled = true;
    showToast("管理者目前暫停上傳。", "error");
  }
}

function inviteTokenFromFragment(): string | null {
  if (!window.location.hash.startsWith("#")) {
    return null;
  }
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  return token === null || token.length === 0 ? null : token;
}

async function exchangeInvitation(
  token: string,
  turnstileToken: string,
): Promise<InvitationSessionInfo> {
  const response = await fetch("/api/invitations/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      turnstileToken,
      accessCode: config?.accessCodeRequired ? accessCodeInput.value : null,
    }),
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  const payload: unknown = await response.json();
  return parseInvitationSession(payload);
}

async function loadInvitationSession(): Promise<InvitationSessionInfo | null> {
  const response = await fetch("/api/invitations/session");
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  const payload: unknown = await response.json();
  return parseInvitationSession(payload);
}

function activateInvitation(session: InvitationSessionInfo): boolean {
  if (!session.canUpload) {
    window.location.assign("/files");
    return false;
  }
  invitationLabel.textContent = session.label;
  invitationRemaining.textContent =
    `${session.remainingFiles === null ? "不限檔案數" : `剩餘 ${session.remainingFiles} 個檔案`}、` +
    `${formatBytes(session.remainingBytes)} 可用；` +
    `邀請於 ${formatDate(session.expiresAt)} 到期。`;
  inviteGate.classList.add("is-hidden");
  uploadWorkspace.classList.remove("is-hidden");
  return true;
}

async function initializeUploadPage(): Promise<void> {
  filesPage.classList.add("is-hidden");
  adminPage.classList.add("is-hidden");
  filePage.classList.add("is-hidden");
  uploadPage.classList.remove("is-hidden");
  await loadConfig();
  const invitationToken = inviteTokenFromFragment();
  if (invitationToken !== null) {
    window.history.replaceState(null, "", window.location.pathname);
    inviteGateTitle.textContent = "完成一次安全驗證";
    inviteGateMessage.textContent =
      `驗證成功後會建立最長 ${formatDuration(config?.sessionTtlSeconds ?? 0)}的邀請 session，` +
      "期間不必為每個檔案重複驗證。";
    inviteVerification.classList.remove("is-hidden");
    if (config?.accessCodeRequired) {
      accessCodeField.classList.remove("is-hidden");
    }
    await turnstile.initialize(config?.turnstileSiteKey ?? "");

    verifyInviteButton.addEventListener("click", () => {
      if (config?.accessCodeRequired && accessCodeInput.value.trim().length === 0) {
        inviteGateMessage.textContent = "請先輸入私人存取碼。";
        accessCodeInput.focus();
        return;
      }

      verifyInviteButton.disabled = true;
      inviteGateTitle.textContent = "正在建立邀請 session";
      inviteGateMessage.textContent = "請完成安全驗證，系統會自動繼續。";
      const controller = new AbortController();
      void turnstile
        .takeToken(controller.signal)
        .then((turnstileToken) => exchangeInvitation(invitationToken, turnstileToken))
        .then(async (session) => {
          if (activateInvitation(session)) {
            await loadStorage();
          }
        })
        .catch((error: unknown) => {
          inviteGateTitle.textContent = "邀請驗證失敗";
          inviteGateMessage.textContent =
            error instanceof Error ? error.message : "請重新完成安全驗證。";
          turnstile.refresh();
          verifyInviteButton.disabled = false;
        });
    });
    return;
  }

  const session = await loadInvitationSession();
  if (session === null) {
    inviteGateTitle.textContent = "需要有效的邀請";
    inviteGateMessage.textContent =
      "請使用分享者提供的完整邀請連結，或掃描對方提供的 NFC／QR Code。";
    return;
  }

  if (activateInvitation(session)) {
    await loadStorage();
  }
}

function setAdminAuthenticated(authenticated: boolean): void {
  adminGate.classList.toggle("is-hidden", authenticated);
  adminWorkspace.classList.toggle("is-hidden", !authenticated);
}

async function hasAdminSession(): Promise<boolean> {
  const response = await fetch("/api/admin/session");
  if (response.status === 401) {
    return false;
  }
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return true;
}

async function hasAdminCapability(): Promise<boolean> {
  const response = await fetch("/api/session/capabilities", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return parseSessionCapabilities(await response.json()).admin;
}

function clearAdminFileCapability(): void {
  adminSessionActive = false;
  setNavigationMode(true);
  adminFilesNotice.classList.add("is-hidden");
  if (window.location.pathname.startsWith("/files")) {
    renderSharedFiles();
  }
}

function requestAdminFileDeletion(file: PublicFile, trigger: HTMLButtonElement): void {
  pendingAdminDelete = { file, trigger };
  deleteFileMessage.textContent =
    `「${file.filename}」將從共享清單移除，新的檔案資訊與下載請求會失效。` +
    "已載入或快取的公開預覽可能短暫保留。此操作無法復原。";
  confirmDeleteFileButton.disabled = false;
  deleteFileDialog.showModal();
  cancelDeleteFileButton.focus();
}

async function deletePendingAdminFile(): Promise<void> {
  if (pendingAdminDelete === null) {
    return;
  }
  const { file, trigger } = pendingAdminDelete;
  trigger.disabled = true;
  confirmDeleteFileButton.disabled = true;
  confirmDeleteFileButton.textContent = "刪除中…";
  try {
    const response = await fetch(`/api/admin/files/${encodeURIComponent(file.id)}`, {
      method: "DELETE",
    });
    await requireAdminNoContent(response);
    sharedFiles = sharedFiles.filter((item) => item.id !== file.id);
    pendingAdminDelete = null;
    deleteFileDialog.close();
    showToast("檔案已刪除；已載入或快取的公開預覽可能短暫保留");
    if (window.location.pathname.startsWith("/file/")) {
      window.location.assign("/files");
      return;
    }
    renderSharedFiles();
    sharedFilesStatus.tabIndex = -1;
    sharedFilesStatus.focus();
  } catch (error) {
    if (error instanceof AdminAuthenticationUnavailableError || error instanceof TypeError) {
      clearAdminFileCapability();
      pendingAdminDelete = null;
      deleteFileDialog.close();
      trigger.remove();
      showToast(ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE, "error");
      globalUploadLink.focus();
    } else {
      showToast(error instanceof Error ? error.message : "無法刪除檔案，請再試一次。", "error");
    }
    trigger.disabled = false;
    confirmDeleteFileButton.disabled = false;
  } finally {
    confirmDeleteFileButton.textContent = "刪除檔案";
  }
}

function invitationStatusLabel(status: AdminInvitation["status"]): string {
  switch (status) {
    case "active":
      return "使用中";
    case "revoked":
      return "已撤銷";
    case "expired":
      return "已到期";
  }
}

function renderInvitationGroup(
  container: HTMLElement,
  invitations: AdminInvitation[],
  emptyMessage: string,
  requestedPage: number,
): { page: number; totalPages: number } {
  if (invitations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = emptyMessage;
    container.replaceChildren(empty);
    return { page: 0, totalPages: 1 };
  }

  const totalPages = Math.ceil(invitations.length / invitationsPerPage);
  const page = Math.min(requestedPage, totalPages - 1);
  const visibleInvitations = invitations.slice(
    page * invitationsPerPage,
    (page + 1) * invitationsPerPage,
  );

  container.replaceChildren(
    ...visibleInvitations.map((invitation) => {
      const card = document.createElement("article");
      card.className = "invitation-card";

      const heading = document.createElement("div");
      heading.className = "invitation-card__heading";
      const label = document.createElement("strong");
      label.textContent = invitation.label;
      const status = document.createElement("span");
      status.className =
        invitation.status === "active"
          ? "status-pill status-pill--active"
          : "status-pill status-pill--inactive";
      status.textContent =
        invitationStatusLabel(invitation.status) + (invitation.canUpload ? "" : " · 僅瀏覽");
      heading.append(label, status);

      const usage = document.createElement("div");
      usage.className = "invitation-card__usage";
      const files = document.createElement("span");
      const bytes = document.createElement("span");
      if (invitation.canUpload) {
        files.textContent = invitation.unlimitedFiles
          ? `${invitation.usedFiles} 個 reservation（不限檔案數）`
          : `${invitation.usedFiles} / ${invitation.maxFiles} 個 reservation`;
        bytes.textContent = `${formatBytes(invitation.usedBytes)} / ${formatBytes(invitation.maxBytes)}`;
      } else {
        files.textContent = "僅瀏覽與下載";
        bytes.textContent = "上傳額度 0 個 · 0 B";
      }
      usage.append(files, bytes);

      const expiry = document.createElement("p");
      expiry.className = "invitation-card__expiry";
      expiry.textContent =
        invitation.status === "revoked" && invitation.revokedAt !== null
          ? `建立：${formatDate(invitation.createdAt)} · 撤銷：${formatDate(invitation.revokedAt)}`
          : `建立：${formatDate(invitation.createdAt)} · 到期：${formatDate(invitation.expiresAt)}`;

      card.append(heading, usage, expiry);
      if (invitation.status === "active") {
        const actions = document.createElement("div");
        actions.className = "invitation-card__actions";

        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "secondary-button";
        copy.textContent = "複製邀請連結";
        copy.title = "建立同一邀請的新連結；原有連結與已登入裝置仍有效";
        copy.addEventListener("click", () => {
          copy.disabled = true;
          copy.textContent = "複製中…";
          void copyAdminInvitation(invitation.id)
            .then(async (copied) => {
              presentInvitationLink(copied);
              await copyText(copied.inviteUrl);
              createdInvite.scrollIntoView({ behavior: "smooth", block: "nearest" });
              showToast("邀請連結已複製；原有連結與已登入裝置仍有效");
            })
            .catch((error: unknown) => {
              showToast(error instanceof Error ? error.message : "無法複製邀請連結。", "error");
            })
            .finally(() => {
              copy.disabled = false;
              copy.textContent = "複製邀請連結";
            });
        });

        const reissue = document.createElement("button");
        reissue.type = "button";
        reissue.className = "secondary-button";
        reissue.textContent = "重新簽發並複製";
        reissue.addEventListener("click", () => {
          if (
            !window.confirm(
              `重新簽發「${invitation.label}」？舊連結與已登入裝置會立即失效，期限和已用額度不變。`,
            )
          ) {
            return;
          }
          reissue.disabled = true;
          void reissueAdminInvitation(invitation.id)
            .then(async (reissued) => {
              presentInvitationLink(reissued);
              await copyText(reissued.inviteUrl);
              createdInvite.scrollIntoView({ behavior: "smooth", block: "nearest" });
              showToast("新連結已簽發；舊連結與既有 session 已失效");
            })
            .catch((error: unknown) => {
              showToast(error instanceof Error ? error.message : "無法重新簽發邀請。", "error");
            })
            .finally(() => {
              reissue.disabled = false;
            });
        });

        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "secondary-button danger-button";
        revoke.textContent = "撤銷邀請";
        revoke.addEventListener("click", () => {
          if (!window.confirm(`撤銷「${invitation.label}」？所有相關邀請 session 也會失效。`)) {
            return;
          }
          revoke.disabled = true;
          void fetch(`/api/admin/invitations/${encodeURIComponent(invitation.id)}`, {
            method: "DELETE",
          })
            .then(async (response) => {
              if (!response.ok) {
                throw new Error(await responseError(response));
              }
              showToast("邀請已撤銷");
              await loadAdminInvitations();
            })
            .catch((error: unknown) => {
              showToast(error instanceof Error ? error.message : "無法撤銷邀請。", "error");
              revoke.disabled = false;
            });
        });
        actions.append(copy, reissue, revoke);
        card.append(actions);
      }
      return card;
    }),
  );
  return { page, totalPages };
}

function updateInvitationPagination(
  pagination: HTMLElement,
  previous: HTMLButtonElement,
  next: HTMLButtonElement,
  status: HTMLElement,
  totalItems: number,
  page: number,
  totalPages: number,
): void {
  pagination.classList.toggle("is-hidden", totalItems <= invitationsPerPage);
  previous.disabled = page === 0;
  next.disabled = page >= totalPages - 1;
  status.textContent = `第 ${page + 1} / ${totalPages} 頁`;
}

function renderInvitations(invitations: AdminInvitation[]): void {
  const active = invitations.filter((invitation) => invitation.status === "active");
  const history = invitations.filter((invitation) => invitation.status !== "active");
  activeInvitationCount.textContent = String(active.length);
  invitationHistoryCount.textContent = String(history.length);

  const activePageResult = renderInvitationGroup(
    activeInvitationList,
    active,
    "目前沒有有效邀請。從左側設定額度後即可建立。",
    activeInvitationPage,
  );
  activeInvitationPage = activePageResult.page;
  updateInvitationPagination(
    activeInvitationPagination,
    activeInvitationPrevious,
    activeInvitationNext,
    activeInvitationPageStatus,
    active.length,
    activeInvitationPage,
    activePageResult.totalPages,
  );

  const historyPageResult = renderInvitationGroup(
    invitationHistoryList,
    history,
    "目前沒有已撤銷或已到期的邀請。",
    invitationHistoryPage,
  );
  invitationHistoryPage = historyPageResult.page;
  updateInvitationPagination(
    invitationHistoryPagination,
    invitationHistoryPrevious,
    invitationHistoryNext,
    invitationHistoryPageStatus,
    history.length,
    invitationHistoryPage,
    historyPageResult.totalPages,
  );
}

async function loadAdminInvitations(): Promise<void> {
  activeInvitationList.innerHTML = '<p class="empty-state">正在讀取邀請。</p>';
  invitationHistoryList.innerHTML = '<p class="empty-state">正在讀取邀請。</p>';
  const response = await fetch("/api/admin/invitations", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.invitations)) {
    throw new Error("Invalid invitation list response.");
  }
  adminInvitations = payload.invitations.map(parseAdminInvitation);
  renderInvitations(adminInvitations);
}

async function createAdminInvitation(): Promise<CreatedInvitation> {
  const days = Number(inviteDaysInput.value);
  const maxFiles = Number(inviteFilesInput.value);
  const unlimitedFiles = inviteUnlimitedFilesInput.checked;
  const megabytes = Number(inviteMbInput.value);
  const label = inviteLabelInput.value.trim();
  const canUpload = inviteUploadModeInput.checked;
  if (
    label.length === 0 ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 365 ||
    (canUpload &&
      ((!unlimitedFiles && (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100)) ||
        !Number.isFinite(megabytes) ||
        megabytes <= 0))
  ) {
    throw new Error("請確認標籤、天數、檔案數與容量設定。 ");
  }
  const response = await fetch("/api/admin/invitations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label,
      expiresInSeconds: days * 86_400,
      canUpload,
      maxFiles: canUpload ? maxFiles : 0,
      unlimitedFiles: canUpload ? unlimitedFiles : false,
      maxBytes: canUpload ? Math.round(megabytes * 1024 * 1024) : 0,
    }),
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return parseCreatedInvitation(await response.json());
}

async function reissueAdminInvitation(invitationId: string): Promise<CreatedInvitation> {
  const response = await fetch(
    `/api/admin/invitations/${encodeURIComponent(invitationId)}/reissue`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return parseCreatedInvitation(await response.json());
}

async function copyAdminInvitation(invitationId: string): Promise<CreatedInvitation> {
  const response = await fetch(`/api/admin/invitations/${encodeURIComponent(invitationId)}/copy`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return parseCreatedInvitation(await response.json());
}

function presentInvitationLink(invitation: CreatedInvitation): void {
  createdInviteLabel.textContent = `${invitation.label} · ${
    invitation.canUpload
      ? `${invitation.unlimitedFiles ? "不限檔案數" : `${invitation.maxFiles} 個`} · ${formatBytes(invitation.maxBytes)}`
      : "僅瀏覽與下載"
  } · 到期 ${formatDate(invitation.expiresAt)}`;
  createdInviteUrl.value = invitation.inviteUrl;
  createdInvite.classList.remove("is-hidden");
}

async function showInvitationQr(inviteUrl: string, label: string): Promise<void> {
  showQrButton.disabled = true;
  try {
    qrImage.src = await QRCode.toDataURL(inviteUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 680,
      color: { dark: "#07111d", light: "#ffffff" },
    });
    qrInviteLabel.textContent = label;
    qrDialog.showModal();
  } finally {
    showQrButton.disabled = false;
  }
}

async function initializeAdminPage(): Promise<void> {
  uploadPage.classList.add("is-hidden");
  filesPage.classList.add("is-hidden");
  filePage.classList.add("is-hidden");
  adminPage.classList.remove("is-hidden");
  setNavigationMode(true);
  await loadConfig();
  if (await hasAdminSession()) {
    adminSessionActive = true;
    setAdminAuthenticated(true);
    await loadAdminInvitations();
    return;
  }
  setAdminAuthenticated(false);
  await adminTurnstile.initialize(config?.turnstileSiteKey ?? "");
}

adminLoginButton.addEventListener("click", () => {
  const adminToken = adminTokenInput.value.trim();
  if (adminToken.length === 0) {
    adminGateMessage.textContent = "請先輸入管理 token。";
    adminTokenInput.focus();
    return;
  }
  adminLoginButton.disabled = true;
  const controller = new AbortController();
  void adminTurnstile
    .takeToken(controller.signal)
    .then(async (turnstileToken) => {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ turnstileToken }),
      });
      adminTokenInput.value = "";
      if (!response.ok) {
        throw new Error(await responseError(response));
      }
      adminSessionActive = true;
      setAdminAuthenticated(true);
      await loadAdminInvitations();
    })
    .catch((error: unknown) => {
      adminTokenInput.value = "";
      adminGateMessage.textContent = error instanceof Error ? error.message : "管理員驗證失敗。";
      adminTurnstile.refresh();
      adminLoginButton.disabled = false;
    });
});

revokeAllAdminSessionsButton.addEventListener("click", () => {
  if (!window.confirm("這會立即撤銷所有管理員登入狀態，包括目前裝置。確定要繼續嗎？")) {
    return;
  }
  revokeAllAdminSessionsButton.disabled = true;
  revokeAllAdminSessionsButton.textContent = "正在登出所有裝置…";
  void fetch("/api/admin/sessions/revoke-all", { method: "POST" })
    .then(requireAdminNoContent)
    .then(async () => {
      adminSessionActive = false;
      adminInvitations = [];
      setAdminAuthenticated(false);
      adminGateMessage.textContent = "所有管理員登入狀態已撤銷，請重新輸入管理 token。";
      adminLoginButton.disabled = false;
      await adminTurnstile.initialize(config?.turnstileSiteKey ?? "");
      adminTurnstile.refresh();
      adminTokenInput.focus();
      showToast("所有管理裝置均已登出");
    })
    .catch((error: unknown) => {
      showToast(
        error instanceof AdminAuthenticationUnavailableError || error instanceof TypeError
          ? ADMIN_AUTHENTICATION_UNAVAILABLE_MESSAGE
          : error instanceof Error
            ? error.message
            : "無法登出所有管理裝置，請再試一次。",
        "error",
      );
    })
    .finally(() => {
      revokeAllAdminSessionsButton.disabled = false;
      revokeAllAdminSessionsButton.textContent = "登出所有管理裝置";
    });
});

function updateInvitationPermissionFields(): void {
  const canUpload = inviteUploadModeInput.checked;
  inviteFilesInput.disabled = !canUpload || inviteUnlimitedFilesInput.checked;
  inviteMbInput.disabled = !canUpload;
  inviteUnlimitedFilesInput.disabled = !canUpload;
  createInviteButton.textContent = canUpload ? "建立並複製邀請" : "建立並複製僅瀏覽邀請";
}

let automaticInvitationLabel = "";

function updateAutomaticInvitationLabel(force = false): void {
  const currentLabel = inviteLabelInput.value.trim();
  if (!force && currentLabel.length > 0 && currentLabel !== automaticInvitationLabel) {
    return;
  }

  automaticInvitationLabel = createDefaultInvitationLabel(
    inviteUploadModeInput.checked ? "upload" : "browse",
  );
  inviteLabelInput.value = automaticInvitationLabel;
}

function handleInvitationPermissionChange(): void {
  updateInvitationPermissionFields();
  updateAutomaticInvitationLabel();
}

inviteForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const submittedAutomaticLabel = automaticInvitationLabel;
  createInviteButton.disabled = true;
  void createAdminInvitation()
    .then(async (invitation) => {
      presentInvitationLink(invitation);
      await copyText(invitation.inviteUrl);
      await loadAdminInvitations();
      if (inviteLabelInput.value.trim() === submittedAutomaticLabel) {
        updateAutomaticInvitationLabel(true);
      }
    })
    .catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : "無法建立邀請。", "error");
    })
    .finally(() => {
      createInviteButton.disabled = false;
    });
});

inviteUnlimitedFilesInput.addEventListener("change", () => {
  updateInvitationPermissionFields();
});
inviteUploadModeInput.addEventListener("change", handleInvitationPermissionChange);
inviteBrowseModeInput.addEventListener("change", handleInvitationPermissionChange);
updateInvitationPermissionFields();
updateAutomaticInvitationLabel(true);

copyInviteButton.addEventListener("click", () => {
  void copyText(createdInviteUrl.value);
});
showQrButton.addEventListener("click", () => {
  if (createdInviteUrl.value.length === 0) {
    return;
  }
  void showInvitationQr(createdInviteUrl.value, createdInviteLabel.textContent ?? "").catch(
    (error: unknown) => {
      showToast(error instanceof Error ? error.message : "無法產生 QR Code。", "error");
    },
  );
});
closeQrButton.addEventListener("click", () => qrDialog.close());
refreshInvitationsButton.addEventListener("click", () => {
  refreshInvitationsButton.disabled = true;
  void loadAdminInvitations()
    .catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : "無法讀取邀請。", "error");
    })
    .finally(() => {
      refreshInvitationsButton.disabled = false;
    });
});

activeInvitationPrevious.addEventListener("click", () => {
  activeInvitationPage = Math.max(0, activeInvitationPage - 1);
  renderInvitations(adminInvitations);
});

activeInvitationNext.addEventListener("click", () => {
  activeInvitationPage += 1;
  renderInvitations(adminInvitations);
});

invitationHistoryPrevious.addEventListener("click", () => {
  invitationHistoryPage = Math.max(0, invitationHistoryPage - 1);
  renderInvitations(adminInvitations);
});

invitationHistoryNext.addEventListener("click", () => {
  invitationHistoryPage += 1;
  renderInvitations(adminInvitations);
});

cancelDeleteFileButton.addEventListener("click", () => deleteFileDialog.close());
confirmDeleteFileButton.addEventListener("click", () => {
  void deletePendingAdminFile();
});
deleteFileDialog.addEventListener("close", () => {
  const trigger = pendingAdminDelete?.trigger;
  pendingAdminDelete = null;
  if (trigger?.isConnected) {
    trigger.focus();
  }
});

function mediaElement(file: PublicFile): HTMLElement | null {
  if (file.previewUrl === null) {
    return null;
  }
  if (file.detectedMime.startsWith("image/")) {
    const image = document.createElement("img");
    image.src = file.previewUrl;
    image.alt = file.filename;
    image.className = "file-preview__media";
    return image;
  }
  if (file.detectedMime.startsWith("video/")) {
    const video = document.createElement("video");
    video.src = file.previewUrl;
    video.controls = true;
    video.preload = "metadata";
    video.className = "file-preview__media";
    return video;
  }
  if (file.detectedMime.startsWith("audio/")) {
    const audio = document.createElement("audio");
    audio.src = file.previewUrl;
    audio.controls = true;
    audio.preload = "metadata";
    audio.className = "file-preview__audio";
    return audio;
  }
  return null;
}

function addDetail(list: HTMLDListElement, label: string, value: string): void {
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value;
  list.append(term, description);
}

async function loadFilePage(fileId: string): Promise<void> {
  uploadPage.classList.add("is-hidden");
  filesPage.classList.add("is-hidden");
  adminPage.classList.add("is-hidden");
  filePage.classList.remove("is-hidden");
  filePage.textContent = "正在取得檔案資訊…";
  await loadConfig();
  adminSessionActive = await hasAdminCapability().catch(() => false);
  setNavigationMode(adminSessionActive);

  const response = await fetch(`/api/files/${encodeURIComponent(fileId)}`);
  if (!response.ok) {
    const heading = document.createElement("h1");
    heading.textContent = response.status === 404 ? "檔案不存在或已到期" : "無法取得檔案";
    const message = document.createElement("p");
    message.textContent = await responseError(response);
    const home = document.createElement("a");
    home.href = "/";
    home.className = "primary-button primary-button--link";
    home.textContent = "回到上傳頁";
    filePage.replaceChildren(heading, message, home);
    return;
  }

  const payload: unknown = await response.json();
  const file = parsePublicFile(payload);
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "檔案資訊";
  const heading = document.createElement("h1");
  heading.textContent = file.filename;
  const summary = document.createElement("p");
  summary.className = "file-page__summary";
  summary.textContent =
    file.previewPolicy === "inline"
      ? "此檔案可在瀏覽器安全預覽，也可下載原始內容。"
      : "此檔案不開放瀏覽器預覽，僅能以附件下載。";

  const preview = document.createElement("div");
  preview.className = "file-preview";
  const media = mediaElement(file);
  if (media === null) {
    preview.textContent = "此檔案沒有內嵌預覽。";
  } else {
    preview.append(media);
  }

  const details = document.createElement("dl");
  details.className = "file-details";
  addDetail(details, "檔案大小", formatBytes(file.sizeBytes));
  addDetail(details, "偵測類型", file.detectedMime);
  addDetail(details, "建立時間", formatDate(file.createdAt));
  addDetail(details, "到期時間", formatDate(file.expiresAt));

  const actions = document.createElement("div");
  actions.className = "file-page__actions";
  const download = document.createElement("a");
  download.href = file.downloadUrl;
  download.className = "primary-button primary-button--link";
  download.textContent = "下載檔案";
  actions.append(download);
  if (file.previewUrl !== null) {
    const openPreview = document.createElement("a");
    openPreview.href = file.previewUrl;
    openPreview.target = "_blank";
    openPreview.rel = "noopener";
    openPreview.className = "text-link";
    openPreview.textContent = "在新分頁預覽";
    actions.append(openPreview);
  }
  actions.append(
    createActionButton("複製下載連結", () => {
      void copyText(file.downloadUrl);
    }),
  );
  if (adminSessionActive) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "secondary-button danger-button";
    deleteButton.textContent = "刪除檔案";
    deleteButton.addEventListener("click", () => requestAdminFileDeletion(file, deleteButton));
    actions.append(deleteButton);
  }

  filePage.replaceChildren(eyebrow, heading, summary, preview, details, actions);
}

function renderDeleteCapabilityState(
  title: string,
  message: string,
  action?: HTMLButtonElement,
): void {
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "上傳者刪除權限";
  const heading = document.createElement("h1");
  heading.textContent = title;
  const description = document.createElement("p");
  description.className = "file-page__summary";
  description.textContent = message;
  const actions = document.createElement("div");
  actions.className = "file-page__actions";
  if (action !== undefined) {
    actions.append(action);
  }
  const home = document.createElement("a");
  home.href = "/";
  home.className = "secondary-button secondary-button--link";
  home.textContent = "回到上傳頁";
  actions.append(home);
  filePage.replaceChildren(eyebrow, heading, description, actions);
}

async function initializeDeletePage(fileId: string): Promise<void> {
  uploadPage.classList.add("is-hidden");
  filesPage.classList.add("is-hidden");
  adminPage.classList.add("is-hidden");
  filePage.classList.remove("is-hidden");
  setNavigationMode(false);

  const deleteToken = deleteTokenFromFragment(window.location.hash);
  if (deleteToken === null) {
    renderDeleteCapabilityState(
      "刪除連結不完整",
      "這個刪除權限只在上傳完成時提供一次。請使用當時保存的完整連結；系統無法補發。",
    );
    return;
  }

  filePage.textContent = "正在確認檔案狀態…";
  await loadConfig();
  const response = await fetch(`/api/files/${encodeURIComponent(fileId)}`);
  if (response.status === 404) {
    renderDeleteCapabilityState(
      "檔案已不存在",
      "檔案可能已由管理員刪除、先前使用這個連結刪除，或已經到期。你不需要再做任何操作。",
    );
    return;
  }
  if (!response.ok) {
    renderDeleteCapabilityState("目前無法確認檔案", await responseError(response));
    return;
  }

  const file = parsePublicFile(await response.json());
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "primary-button danger-button";
  deleteButton.textContent = "永久刪除這個檔案";
  deleteButton.addEventListener("click", () => {
    deleteButton.disabled = true;
    deleteButton.textContent = "正在刪除…";
    void fetch(`/api/delete/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: { Authorization: `DeleteToken ${deleteToken}` },
    })
      .then(async (deleteResponse) => {
        if (deleteResponse.status !== 204) {
          throw new Error(await responseError(deleteResponse));
        }
        window.history.replaceState(null, "", `/delete/${encodeURIComponent(fileId)}`);
        renderDeleteCapabilityState(
          "檔案已刪除",
          "檔案已從暫存區移除；已載入或快取的公開預覽可能短暫保留。",
        );
      })
      .catch((error: unknown) => {
        deleteButton.disabled = false;
        deleteButton.textContent = "永久刪除這個檔案";
        showToast(error instanceof Error ? error.message : "無法刪除檔案。", "error");
      });
  });
  renderDeleteCapabilityState(
    `刪除「${file.filename}」？`,
    "這個動作無法復原，只會刪除這一個檔案。連結中的刪除權限不會授予其他檔案或管理功能。",
    deleteButton,
  );
}

chooseButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files !== null) {
    enqueueFiles(fileInput.files);
    fileInput.value = "";
  }
});
dropZone.addEventListener("click", (event) => {
  if (event.target !== chooseButton) {
    fileInput.click();
  }
});
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  if (event.dataTransfer !== null) {
    enqueueFiles(event.dataTransfer.files);
  }
});
document.addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (files.length > 0) {
    enqueueFiles(files);
  }
});

fileTypeFilters.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) {
    return;
  }
  const type = target.dataset.fileType;
  if (
    type !== "all" &&
    type !== "image" &&
    type !== "video" &&
    type !== "audio" &&
    type !== "other"
  ) {
    return;
  }
  sharedFilesType = type;
  for (const button of fileTypeFilters.querySelectorAll<HTMLButtonElement>("[data-file-type]")) {
    const selected = button === target;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  void loadSharedFiles(true).catch((error: unknown) => {
    sharedFilesStatus.textContent = error instanceof Error ? error.message : "無法篩選檔案。";
    retrySharedFilesButton.classList.remove("is-hidden");
  });
});

retrySharedFilesButton.addEventListener("click", () => {
  retrySharedFilesButton.disabled = true;
  void loadSharedFiles(true)
    .catch((error: unknown) => {
      sharedFilesStatus.textContent = error instanceof Error ? error.message : "無法讀取共享檔案。";
      retrySharedFilesButton.classList.remove("is-hidden");
    })
    .finally(() => {
      retrySharedFilesButton.disabled = false;
    });
});

loadMoreSharedFilesButton.addEventListener("click", () => {
  void loadSharedFiles(false).catch((error: unknown) => {
    sharedFilesStatus.textContent = error instanceof Error ? error.message : "無法載入更多檔案。";
    retrySharedFilesButton.classList.remove("is-hidden");
    loadMoreSharedFilesButton.disabled = false;
  });
});
downloadDeleteLinksButton.addEventListener("click", downloadDeleteLinks);

const filePageMatch = /^\/file\/([^/]+)$/u.exec(window.location.pathname);
const deletePageMatch = /^\/delete\/([^/]+)$/u.exec(window.location.pathname);
if (window.location.pathname === "/admin" || window.location.pathname === "/admin/") {
  void initializeAdminPage().catch((error: unknown) => {
    adminGateMessage.textContent = error instanceof Error ? error.message : "管理頁載入失敗。";
  });
} else if (window.location.pathname === "/files" || window.location.pathname === "/files/") {
  void initializeFilesPage().catch((error: unknown) => {
    sharedFilesStatus.textContent =
      error instanceof Error ? error.message : "無法載入檔案清單設定。";
    retrySharedFilesButton.classList.remove("is-hidden");
  });
} else if (filePageMatch?.[1] !== undefined) {
  void loadFilePage(decodeURIComponent(filePageMatch[1])).catch((error: unknown) => {
    filePage.textContent = error instanceof Error ? error.message : "無法載入檔案資訊。";
  });
} else if (deletePageMatch?.[1] !== undefined) {
  void initializeDeletePage(decodeURIComponent(deletePageMatch[1])).catch((error: unknown) => {
    renderDeleteCapabilityState(
      "無法開啟刪除連結",
      error instanceof Error ? error.message : "請稍後再試。",
    );
  });
} else {
  void initializeUploadPage().catch((error: unknown) => {
    inviteGateTitle.textContent = "邀請驗證失敗";
    inviteGateMessage.textContent = error instanceof Error ? error.message : "請重新取得邀請連結。";
  });
}

export {};
