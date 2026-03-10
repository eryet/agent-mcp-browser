import fs from "node:fs/promises";
import path from "node:path";

export type PlaybookVariable = {
  description: string;
  default?: string;
};

export type PlaybookStep = {
  id: number;
  action: string;
  expectedState: string;
  selectors?: string[];
  onError?: string;
};

export type PlaybookMetadata = {
  name: string;
  description: string;
  createdAt: string;
  plannerModel: string;
  sourceTask: string;
};

export type Playbook = {
  version: string;
  metadata: PlaybookMetadata;
  variables: Record<string, PlaybookVariable>;
  steps: PlaybookStep[];
};

export async function loadPlaybook(filePath: string): Promise<Playbook> {
  const absolutePath = path.resolve(filePath);
  const raw = await fs.readFile(absolutePath, "utf-8");
  const parsed = JSON.parse(raw) as Playbook;

  if (!parsed.version || !parsed.metadata || !Array.isArray(parsed.steps)) {
    throw new Error(`Playbook 格式無效：${absolutePath}`);
  }

  return parsed;
}

export async function savePlaybook(
  playbook: Playbook,
  outputDir: string,
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "")
    .slice(0, 15);
  const safeName = playbook.metadata.name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 40);
  const fileName = `${safeName}-${timestamp}.json`;
  const filePath = path.join(outputDir, fileName);

  await fs.writeFile(filePath, JSON.stringify(playbook, null, 2), "utf-8");
  return filePath;
}

function replaceVariablesInString(
  text: string,
  resolvedVars: Record<string, string>,
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
    return resolvedVars[varName] ?? `{{${varName}}}`;
  });
}

export function substituteVariables(
  playbook: Playbook,
  overrides: Record<string, string>,
): Playbook {
  const resolvedVars: Record<string, string> = {};

  for (const [key, variable] of Object.entries(playbook.variables)) {
    const value = overrides[key] ?? variable.default;
    if (value !== undefined) {
      resolvedVars[key] = value;
    }
  }

  // Also include overrides not defined in variables
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in resolvedVars)) {
      resolvedVars[key] = value;
    }
  }

  const resolvedSteps = playbook.steps.map((step) => ({
    ...step,
    action: replaceVariablesInString(step.action, resolvedVars),
    expectedState: replaceVariablesInString(step.expectedState, resolvedVars),
    onError: step.onError
      ? replaceVariablesInString(step.onError, resolvedVars)
      : undefined,
  }));

  // Warn about unresolved variables
  const allText = resolvedSteps
    .map((s) => `${s.action} ${s.expectedState} ${s.onError ?? ""}`)
    .join(" ");
  const unresolved = allText.match(/\{\{\w+\}\}/g);
  if (unresolved) {
    const unique = [...new Set(unresolved)];
    console.warn(`[playbook] 未解析的變數：${unique.join(", ")}`);
  }

  return { ...playbook, steps: resolvedSteps };
}

export const EXECUTOR_INSTRUCTIONS =
  "你是瀏覽器自動化執行器。你會收到一份詳細的步驟清單。請嚴格按照步驟順序逐一執行，不要跳過、合併或自行推理。每完成一個步驟，確認預期狀態是否符合，如果不符合，參考錯誤處理提示。如果某步驟反覆失敗，報告失敗原因並繼續下一步。使用建議的選擇器尋找元素，如果找不到，嘗試用文字內容或 ARIA 標籤定位。若動作涉及加入購物車、填寫個資、付款或提交訂單，必須先要求使用者明確確認。絕對不要使用 browser_take_screenshot 工具，因為截圖功能在此模式下不支援，請改用 browser_snapshot 來確認頁面狀態。回覆請使用繁體中文。";

export function formatPlaybookAsTaskPrompt(playbook: Playbook): string {
  const lines: string[] = [
    "你是瀏覽器自動化執行器。請嚴格按照以下步驟逐一操作，不要跳步或自行推理。",
    "",
    `任務：${playbook.metadata.description}`,
    "",
  ];

  for (const step of playbook.steps) {
    lines.push(`步驟 ${step.id}：${step.action}`);
    lines.push(`  預期狀態：${step.expectedState}`);

    if (step.selectors && step.selectors.length > 0) {
      lines.push(`  建議選擇器：${step.selectors.join(", ")}`);
    }

    if (step.onError) {
      lines.push(`  錯誤處理：${step.onError}`);
    }

    lines.push("");
  }

  lines.push(
    "完成所有步驟後，輸出執行摘要（成功步驟數、失敗步驟數、最終頁面狀態）。",
  );
  lines.push(
    "若動作涉及加入購物車、填寫個資、付款或提交訂單，必須先要求使用者明確確認。",
  );

  return lines.join("\n");
}
