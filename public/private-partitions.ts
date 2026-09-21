interface Partition {
  id: string;
  label: string;
  status: string;
  maxFiles: number;
  unlimitedFiles: boolean;
  maxBytes: number;
  usedFiles: number;
  usedBytes: number;
  expiresAt: string;
  credentialCount: number;
  pendingFiles: number;
}

function required<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing #${id}`);
  return element;
}

const select = required("invitePartitionSelect", HTMLSelectElement);
const name = required("newPartitionNameInput", HTMLInputElement);
const nameField = required("newPartitionNameField", HTMLElement);
const hint = required("invitePartitionHint", HTMLElement);
const list = required("privatePartitionList", HTMLElement);
const history = required("privatePartitionHistory", HTMLDetailsElement);
const historyList = required("privatePartitionHistoryList", HTMLUListElement);
const historyCount = required("privatePartitionHistoryCount", HTMLElement);
const days = required("inviteDaysInput", HTMLInputElement);
const files = required("inviteFilesInput", HTMLInputElement);
const bytes = required("inviteMbInput", HTMLInputElement);
const unlimited = required("inviteUnlimitedFilesInput", HTMLInputElement);
let partitions: Partition[] = [];

export function existingPartitionSelected(): boolean {
  return select.value !== "shared" && select.value !== "new";
}

export function credentialPartitionFields(): { partitionId?: string; partitionLabel?: string } {
  if (select.value === "new") return { partitionLabel: name.value.trim() };
  return existingPartitionSelected() ? { partitionId: select.value } : {};
}

export function updatePartitionFields(): void {
  const fresh = select.value === "new";
  nameField.classList.toggle("is-hidden", !fresh);
  name.disabled = !fresh;
  name.required = fresh;
  const partition = partitions.find((p) => p.id === select.value);
  days.disabled = existingPartitionSelected();
  if (partition) {
    days.value = String(
      Math.max(1, Math.ceil((Date.parse(partition.expiresAt) - Date.now()) / 86_400_000)),
    );
    files.value = String(partition.maxFiles);
    bytes.value = String(partition.maxBytes / 1024 / 1024);
    unlimited.checked = partition.unlimitedFiles;
    files.disabled = bytes.disabled = unlimited.disabled = true;
    hint.textContent = `沿用「${partition.label}」的期限與額度，到期 ${new Date(partition.expiresAt).toLocaleString("zh-TW")}。增發憑證不增加配額；請填寫不同的上傳者名稱。`;
  } else {
    hint.textContent = fresh
      ? "下方期限與額度屬於整個分區。已知單檔連結仍可分享；最後一張憑證撤銷後會刪除整區檔案。"
      : "一般邀請使用共用暫存區。";
  }
}

export function onPartitionSelectionChange(callback: () => void): void {
  select.addEventListener("change", callback);
}

function parsePartition(value: unknown): Partition {
  if (typeof value !== "object" || value === null) throw new Error("無法讀取分區資料。");
  const p = value as Record<string, unknown>;
  for (const key of ["id", "label", "status", "expiresAt"] as const) {
    if (typeof p[key] !== "string") throw new Error("分區資料格式不正確。");
  }
  for (const key of [
    "maxFiles",
    "maxBytes",
    "usedFiles",
    "usedBytes",
    "credentialCount",
    "pendingFiles",
  ] as const) {
    if (typeof p[key] !== "number" || !Number.isFinite(p[key]))
      throw new Error("分區額度格式不正確。");
  }
  if (typeof p.unlimitedFiles !== "boolean") throw new Error("分區設定格式不正確。");
  return value as Partition;
}

async function mutation(id: string, method: "PATCH" | "DELETE", body?: unknown): Promise<void> {
  const response = await fetch(`/api/admin/partitions/${encodeURIComponent(id)}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const payload: unknown = await response.json();
    const error =
      typeof payload === "object" && payload !== null && "error" in payload ? payload.error : null;
    throw new Error(
      typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
        ? error.message
        : "操作失敗，請重新整理後再試。",
    );
  }
}

function field(
  form: HTMLFormElement,
  label: string,
  value: string,
  type = "number",
): HTMLInputElement {
  const wrapper = document.createElement("label");
  wrapper.className = "form-field";
  const text = document.createElement("span");
  text.textContent = label;
  const input = document.createElement("input");
  input.type = type;
  input.name = label;
  input.value = value;
  input.required = true;
  if (type === "number") input.min = "1";
  wrapper.append(text, input);
  form.append(wrapper);
  return input;
}

function renderPartition(p: Partition, refresh: () => Promise<void>): HTMLElement {
  const card = document.createElement("article");
  card.className = "invitation-card";
  const title = document.createElement("h3");
  title.textContent = p.label;
  const summary = document.createElement("p");
  summary.textContent =
    p.status === "active"
      ? `${p.credentialCount} 張有效憑證 · 已用 ${p.usedFiles} / ${p.unlimitedFiles ? "不限" : p.maxFiles} 個 · ${(p.usedBytes / 1024 / 1024).toFixed(1)} / ${(p.maxBytes / 1024 / 1024).toFixed(1)} MiB · 到期 ${new Date(p.expiresAt).toLocaleString("zh-TW")}`
      : `${p.pendingFiles > 0 ? "等待清理" : "已關閉"} · ${p.pendingFiles} 個待清理檔案`;
  card.append(title, summary);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  if (p.status === "active") {
    const actions = document.createElement("div");
    actions.className = "invitation-card__actions";
    const browse = document.createElement("a");
    browse.href = `/files?partition=${encodeURIComponent(p.id)}`;
    browse.className = "secondary-button secondary-button--link";
    browse.textContent = "查看分區檔案";
    const issue = document.createElement("button");
    issue.type = "button";
    issue.className = "secondary-button";
    issue.textContent = "增發憑證";
    issue.addEventListener("click", () => {
      select.value = p.id;
      select.dispatchEvent(new Event("change"));
      required("inviteLabelInput", HTMLInputElement).focus();
    });
    actions.append(browse, issue);
    card.append(actions);
    const editor = document.createElement("details");
    const caption = document.createElement("summary");
    caption.textContent = "修改分區期限與額度";
    const form = document.createElement("form");
    form.className = "invite-form partition-editor";
    const label = field(form, "分區名稱", p.label, "text");
    label.maxLength = 80;
    label.parentElement?.classList.add("form-field--wide");
    const local = new Date(p.expiresAt);
    const localDate = new Date(local.getTime() - local.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    const expiry = field(form, "到期時間", localDate, "datetime-local");
    expiry.parentElement?.classList.add("form-field--wide");
    const maxFiles = field(form, "最多檔案", String(p.maxFiles));
    maxFiles.max = "100";
    const maxMb = field(form, "總容量 MiB", String(p.maxBytes / 1024 / 1024));
    maxMb.step = "any";
    const checkLabel = document.createElement("label");
    checkLabel.className = "checkbox-field form-field--wide";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.name = "unlimitedFiles";
    check.checked = p.unlimitedFiles;
    checkLabel.append(check, "不限檔案數");
    maxFiles.disabled = check.checked;
    check.addEventListener("change", () => {
      maxFiles.disabled = check.checked;
    });
    const note = document.createElement("p");
    note.className = "form-field--wide";
    note.textContent =
      "變更會套用所有憑證。降低至已用額度以下會停止新上傳；既有檔案不因額度調整刪除，且每個檔案最多保留 90 天。";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "primary-button";
    save.textContent = "儲存分區設定";
    form.append(checkLabel, note, save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      save.disabled = true;
      status.textContent = "正在儲存設定。";
      void mutation(p.id, "PATCH", {
        label: label.value.trim(),
        expiresAt: expiry.value === localDate ? p.expiresAt : new Date(expiry.value).toISOString(),
        maxFiles: Number(maxFiles.value),
        unlimitedFiles: check.checked,
        maxBytes: Math.round(Number(maxMb.value) * 1024 * 1024),
      })
        .then(refresh)
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : "儲存失敗。";
        })
        .finally(() => {
          save.disabled = false;
        });
    });
    editor.append(caption, form);
    card.append(editor);
  }
  if (p.status === "active" || p.pendingFiles > 0) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary-button danger-button";
    remove.textContent = p.status === "active" ? "刪除私密分區" : "繼續清理";
    remove.addEventListener("click", () => {
      if (
        p.status === "active" &&
        !window.confirm(
          `刪除「${p.label}」？將撤銷全部 ${p.credentialCount} 張憑證並刪除該區所有檔案，無法復原。已快取的分享內容可能短暫保留。`,
        )
      )
        return;
      remove.disabled = true;
      status.textContent = "正在清理分區。";
      void mutation(p.id, "DELETE")
        .then(refresh)
        .catch((error: unknown) => {
          status.textContent = error instanceof Error ? error.message : "清理失敗，稍後可重試。";
        })
        .finally(() => {
          remove.disabled = false;
        });
    });
    card.append(remove);
  }
  card.append(status);
  return card;
}

function renderPartitionHistory(p: Partition): HTMLLIElement {
  const row = document.createElement("li");
  const label = document.createElement("span");
  label.textContent = p.label;
  const status = document.createElement("span");
  status.className = "partition-history__status";
  status.textContent = "已清理完成";
  row.append(label, status);
  return row;
}

export async function loadPrivatePartitions(refresh: () => Promise<void>): Promise<void> {
  const response = await fetch("/api/admin/partitions", { cache: "no-store" });
  if (!response.ok) throw new Error("無法讀取私密分區，請重新整理。");
  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("partitions" in payload) ||
    !Array.isArray(payload.partitions)
  )
    throw new Error("分區清單格式不正確。");
  partitions = payload.partitions.map(parsePartition);
  const previous = select.value;
  select.replaceChildren(
    new Option("共用暫存區", "shared"),
    new Option("建立新的私密分區", "new"),
    ...partitions
      .filter((p) => p.status === "active")
      .map((p) => new Option(`增發：${p.label}`, p.id)),
  );
  select.value = [...select.options].some((o) => o.value === previous) ? previous : "shared";
  select.dispatchEvent(new Event("change"));
  const current = partitions.filter((p) => p.status === "active" || p.pendingFiles > 0);
  const completed = partitions.filter((p) => p.status !== "active" && p.pendingFiles === 0);
  list.replaceChildren(...current.map((p) => renderPartition(p, refresh)));
  list.classList.toggle("is-hidden", current.length === 0 && completed.length > 0);
  historyList.replaceChildren(...completed.map(renderPartitionHistory));
  historyCount.textContent = String(completed.length);
  history.classList.toggle("is-hidden", completed.length === 0);
  if (partitions.length === 0)
    list.textContent = "尚無私密分區。可在建立邀請時選擇「建立新的私密分區」。";
}
