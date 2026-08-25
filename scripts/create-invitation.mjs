import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const defaults = {
  label: "upload",
  days: undefined,
  files: undefined,
  mb: undefined,
};

const optionNames = new Set(["--label", "--days", "--files", "--mb"]);

function usage() {
  console.log(`建立上傳邀請並將網址複製到剪貼簿。

用法：
  pnpm invite:create [選項]

選項：
  --label <名稱>  邀請名稱，預設 upload
  --days <天數>   有效天數；未指定時使用 Worker 設定，可設定 1 至 365 天
  --files <數量>  最多檔案數；未指定時使用 Worker 設定
  --mb <容量>     總容量 MiB；未指定時使用 Worker 設定
  --help          顯示說明

環境變數：
  ADMIN_TOKEN     必填，正式環境的管理員 token
`);
}

function parseNumber(value, name, { integer = true, maximum } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
    throw new Error(`${name} 必須是正數${integer ? "整數" : ""}。`);
  }
  if (maximum !== undefined && parsed > maximum) {
    throw new Error(`${name} 不得大於 ${maximum}。`);
  }
  return parsed;
}

function parseArguments(argv) {
  const values = { ...defaults };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true, values };
    }

    const equalsAt = argument.indexOf("=");
    const name = equalsAt === -1 ? argument : argument.slice(0, equalsAt);
    if (!optionNames.has(name)) {
      throw new Error(`不支援的選項：${argument}`);
    }

    const inlineValue = equalsAt === -1 ? undefined : argument.slice(equalsAt + 1);
    const value = inlineValue ?? argv[index + 1];
    if (!value || (inlineValue === undefined && value.startsWith("--"))) {
      throw new Error(`${name} 缺少值。`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }

    switch (name) {
      case "--label":
        values.label = value.trim();
        break;
      case "--days":
        values.days = parseNumber(value, "--days");
        break;
      case "--files":
        values.files = parseNumber(value, "--files");
        break;
      case "--mb":
        values.mb = parseNumber(value, "--mb", { integer: false });
        break;
    }
  }

  if (values.label.length === 0 || values.label.length > 80) {
    throw new Error("--label 必須介於 1 到 80 個字元。");
  }

  return { help: false, values };
}

function copyToClipboard(value) {
  if (process.platform !== "win32") {
    return false;
  }
  const result = spawnSync("clip.exe", [], {
    input: value,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 && result.error === undefined;
}

function readAdminTokenFromFile(fileName) {
  const filePath = `${projectRoot}${fileName}`;
  if (!existsSync(filePath)) {
    return undefined;
  }

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const match = /^\s*ADMIN_TOKEN\s*=\s*(.*)\s*$/u.exec(line);
    if (!match) {
      continue;
    }

    let value = match[1].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.at(-1) === quote) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }

  return undefined;
}

function getAdminToken() {
  const environmentToken = process.env.ADMIN_TOKEN?.trim();
  if (environmentToken) {
    return environmentToken;
  }

  for (const fileName of [".env.local", ".env", ".dev.vars"]) {
    const token = readAdminTokenFromFile(fileName);
    if (token) {
      return token;
    }
  }

  return undefined;
}

async function createInvitation(values, adminToken) {
  const body = { label: values.label };
  if (values.days !== undefined) {
    body.expiresInSeconds = values.days * 24 * 60 * 60;
  }
  if (values.files !== undefined) {
    body.maxFiles = values.files;
  }
  if (values.mb !== undefined) {
    body.maxBytes = Math.round(values.mb * 1024 * 1024);
  }
  const response = await fetch("https://upload.jwander.net/api/admin/invitations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    result = null;
  }

  if (!response.ok) {
    const message = result?.error?.message ?? result?.message ?? responseText;
    throw new Error(`建立邀請失敗（HTTP ${response.status}）：${message || "未知錯誤"}`);
  }
  if (typeof result?.inviteUrl !== "string") {
    throw new Error("伺服器回應缺少 inviteUrl。");
  }

  return result;
}

async function main() {
  const { help, values } = parseArguments(process.argv.slice(2));
  if (help) {
    usage();
    return;
  }

  const adminToken = getAdminToken();
  if (!adminToken) {
    throw new Error(
      "找不到 ADMIN_TOKEN。請在專案根目錄建立 .env，內容為 ADMIN_TOKEN=你的管理Token。",
    );
  }

  const invitation = await createInvitation(values, adminToken);
  const copied = copyToClipboard(invitation.inviteUrl);

  console.log("\n邀請已建立。");
  console.log(`名稱：${invitation.label}`);
  console.log(`到期：${invitation.expiresAt}`);
  console.log(
    `限制：${invitation.maxFiles} 個檔案 / ${(invitation.maxBytes / 1024 / 1024).toFixed(2)} MiB`,
  );
  console.log(`ID：${invitation.id}`);
  console.log(`\n${invitation.inviteUrl}\n`);
  console.log(copied ? "邀請網址已複製到剪貼簿。" : "請手動複製上方邀請網址。");
}

main().catch((error) => {
  console.error(`\n錯誤：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
