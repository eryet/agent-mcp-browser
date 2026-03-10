import { run } from "@openai/agents";
import { connectRuntime } from "./runtime.js";
import { type Playbook, savePlaybook } from "./playbook.js";
import type { RuntimeConfig } from "./config.js";

const PLANNER_INSTRUCTIONS = `你是自動化流程規劃師。使用者會給你一個高階任務描述。
你的目標是將它分解為具體的、可由弱模型逐步執行的瀏覽器操作步驟。

你可以先使用瀏覽器工具（MCP 工具）探索目標網站，了解頁面結構、按鈕、表單等，
然後基於你的觀察，產出一份精確的 playbook。

每個步驟必須包含：
- id：步驟編號（從 1 開始）
- action：具體要做什麼（點擊、輸入、選擇、截圖等），盡量包含元素文字或位置描述
- expectedState：執行完畢後頁面應呈現的狀態
- selectors：建議的 CSS 選擇器、ARIA 標籤或元素文字描述（選填）
- onError：如果步驟失敗的備用做法（選填）

如果任務中有可變部分（日期、用戶名、URL 等），用 {{variableName}} 標記，
並在 variables 欄位定義這些變數（含 description 和 default）。

最後請輸出嚴格的 JSON 格式（不要包裹在 markdown code fence 中）：
{
  "version": "1",
  "metadata": {
    "name": "簡短英文名稱（kebab-case）",
    "description": "任務的一句話描述",
    "createdAt": "ISO 8601 時間",
    "plannerModel": "你的模型名稱",
    "sourceTask": "使用者原始任務"
  },
  "variables": {
    "variableName": { "description": "說明", "default": "預設值" }
  },
  "steps": [
    { "id": 1, "action": "...", "expectedState": "...", "selectors": ["..."], "onError": "..." }
  ]
}`;

function extractJsonFromOutput(output: string): string {
  // Try to parse directly first
  const trimmed = output.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  // Extract from markdown code fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Find first { to last }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error("無法從規劃師輸出中提取 JSON。");
}

export async function generatePlaybook(
  task: string,
  config: RuntimeConfig,
): Promise<string> {
  console.log("[plan] 連線 MCP server...");
  const runtime = await connectRuntime({
    mcpUrl: config.mcpUrl,
    model: config.plannerModel,
    mcpTimeout: config.mcpTimeout,
    connectTimeout: config.connectTimeout,
    instructions: PLANNER_INSTRUCTIONS,
  });

  try {
    console.log(`[plan] 使用模型：${config.plannerModel}`);
    console.log(`[plan] 任務：${task}`);
    console.log("[plan] 開始規劃（可能需要探索目標網站）...\n");

    const plannerMaxTurns = Math.max(config.maxTurns, 20);

    const result = await run(runtime.agent, task, {
      maxTurns: plannerMaxTurns,
    });

    const rawOutput =
      typeof result.finalOutput === "string"
        ? result.finalOutput
        : JSON.stringify(result.finalOutput);

    const jsonStr = extractJsonFromOutput(rawOutput);
    const playbook = JSON.parse(jsonStr) as Playbook;

    // Validate basic structure
    if (!playbook.metadata || !Array.isArray(playbook.steps)) {
      throw new Error("規劃師輸出的 JSON 缺少必要欄位（metadata 或 steps）。");
    }

    // Ensure version
    playbook.version = playbook.version || "1";

    const savedPath = await savePlaybook(playbook, config.playbookDir);
    console.log(`\n[plan] Playbook 已儲存：${savedPath}`);
    console.log(`[plan] 步驟數：${playbook.steps.length}`);
    console.log(
      `[plan] 變數：${Object.keys(playbook.variables || {}).join(", ") || "（無）"}`,
    );

    return savedPath;
  } finally {
    await runtime.close();
  }
}
