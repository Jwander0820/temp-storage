import { limitUploadBatch } from "./upload-limits";

interface PublicConfig {
  readonly maxFileBytes: number;
  readonly fileRetentionSeconds: number;
  readonly uploadsEnabled: boolean;
  readonly turnstileSiteKey: string;
  readonly accessCodeRequired: boolean;
  readonly maxFilesPerBatch: number;
  readonly maxParallelUploads: number;
  readonly sessionTtlSeconds: number;
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
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly usedFiles: number;
  readonly usedBytes: number;
  readonly remainingFiles: number;
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
}

interface Reservation {
  readonly uploadId: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: "invite";
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
const filePage = elementById("filePage", HTMLElement);
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
const uploadQueue = elementById("uploadQueue", HTMLOListElement);
const queueCount = elementById("queueCount", HTMLElement);
const uploadHelp = elementById("upload-help", HTMLElement);
const toastRegion = elementById("toastRegion", HTMLElement);

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
    maxFiles: requiredNumber(value, "maxFiles"),
    maxBytes: requiredNumber(value, "maxBytes"),
    usedFiles: requiredNumber(value, "usedFiles"),
    usedBytes: requiredNumber(value, "usedBytes"),
    remainingFiles: requiredNumber(value, "remainingFiles"),
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
  return {
    id: requiredString(value, "id"),
    filename: requiredString(value, "filename"),
    sizeBytes: requiredNumber(value, "sizeBytes"),
    detectedMime: requiredString(value, "detectedMime"),
    previewPolicy,
    previewUrl,
    downloadUrl: requiredString(value, "downloadUrl"),
    createdAt: requiredString(value, "createdAt"),
    expiresAt: requiredString(value, "expiresAt"),
  };
}

function parseCompletedUpload(value: unknown): CompletedUpload {
  if (!isRecord(value)) {
    throw new Error("Invalid upload response.");
  }
  return {
    ...parsePublicFile(value),
    deleteToken: requiredString(value, "deleteToken"),
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

class TurnstileTokenManager {
  private widgetId: string | null = null;
  private token: string | null = null;
  private readonly waiters: Array<{
    resolve(token: string): void;
    reject(error: Error): void;
  }> = [];

  async initialize(siteKey: string): Promise<void> {
    if (siteKey.length === 0 || siteKey.startsWith("replace-with-")) {
      turnstileContainer.textContent = "上傳驗證尚未完成設定，功能暫停。";
      turnstileContainer.classList.add("turnstile-slot--error");
      return;
    }

    await this.loadScript();
    const api = window.turnstile;
    if (api === undefined) {
      throw new Error("安全驗證載入失敗。");
    }

    this.widgetId = api.render(turnstileContainer, {
      sitekey: siteKey,
      action: "invite",
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

const turnstile = new TurnstileTokenManager();

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
    `單一檔案上限 ${formatBytes(config.maxFileBytes)}；` +
    `同時處理 ${config.maxParallelUploads} 個上傳。完成後可直接複製分享或下載連結。`;
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

function activateInvitation(session: InvitationSessionInfo): void {
  invitationLabel.textContent = session.label;
  invitationRemaining.textContent =
    `剩餘 ${session.remainingFiles} 個檔案、${formatBytes(session.remainingBytes)}；` +
    `邀請於 ${formatDate(session.expiresAt)} 到期。`;
  inviteGate.classList.add("is-hidden");
  uploadWorkspace.classList.remove("is-hidden");
}

async function initializeUploadPage(): Promise<void> {
  await loadConfig();
  const invitationToken = inviteTokenFromFragment();
  if (invitationToken !== null) {
    window.history.replaceState(null, "", window.location.pathname);
    inviteGateTitle.textContent = "完成一次安全驗證";
    inviteGateMessage.textContent =
      `驗證成功後會建立最長 ${formatDuration(config?.sessionTtlSeconds ?? 0)}的上傳 session，` +
      "期間不必為每個檔案重複驗證。";
    inviteVerification.classList.remove("is-hidden");
    if (config?.accessCodeRequired) {
      accessCodeField.classList.remove("is-hidden");
    }
    await turnstile.initialize(config?.turnstileSiteKey ?? "");

    verifyInviteButton.addEventListener("click", () => {
      if (config?.accessCodeRequired && accessCodeInput.value.trim().length === 0) {
        inviteGateMessage.textContent = "請先輸入私人上傳碼。";
        accessCodeInput.focus();
        return;
      }

      verifyInviteButton.disabled = true;
      inviteGateTitle.textContent = "正在建立上傳 session";
      inviteGateMessage.textContent = "請完成安全驗證，系統會自動繼續。";
      const controller = new AbortController();
      void turnstile
        .takeToken(controller.signal)
        .then((turnstileToken) => exchangeInvitation(invitationToken, turnstileToken))
        .then(async (session) => {
          activateInvitation(session);
          await loadStorage();
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
    inviteGateTitle.textContent = "需要有效的上傳邀請";
    inviteGateMessage.textContent =
      "請使用分享者提供的完整邀請連結，或掃描對方提供的 NFC／QR Code。";
    return;
  }

  activateInvitation(session);
  await loadStorage();
}

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
  filePage.classList.remove("is-hidden");
  filePage.textContent = "正在取得檔案資訊…";

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

  filePage.replaceChildren(eyebrow, heading, summary, preview, details, actions);
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

const filePageMatch = /^\/file\/([^/]+)$/u.exec(window.location.pathname);
if (filePageMatch?.[1] !== undefined) {
  void loadFilePage(decodeURIComponent(filePageMatch[1]));
} else {
  void initializeUploadPage().catch((error: unknown) => {
    inviteGateTitle.textContent = "邀請驗證失敗";
    inviteGateMessage.textContent = error instanceof Error ? error.message : "請重新取得邀請連結。";
  });
}

export {};
