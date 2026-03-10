import { run } from "@openai/agents";
import { connectRuntime } from "./runtime.js";
import { type Playbook, savePlaybook } from "./playbook.js";
import type { RuntimeConfig } from "./config.js";

const PLANNER_INSTRUCTIONS = `你是自動化流程規劃師。使用者會給你一個高階任務描述。
你的目標是將它分解為具體的、可由弱模型（GPT-4.1-mini）逐步執行的瀏覽器操作步驟。

重要：弱模型無法自行推理或判斷，所以你必須把每個操作寫得極度詳細、具體。
弱模型只會機械式地執行你寫的步驟，不會變通。

你可以先使用瀏覽器工具（MCP 工具）探索目標網站，了解頁面結構、按鈕、表單等，
然後基於你的觀察，產出一份精確的 playbook。

步驟撰寫規則：
1. 登入、認證、OAuth 等複雜流程必須拆成細步驟（每步一個操作）。
2. 簡單表單填寫可以合併：同一頁面上連續填寫多個欄位可以寫在同一步驟，用條列列出每個欄位的操作。
3. 只在關鍵時刻使用 browser_snapshot：頁面跳轉後、登入完成後、進入新頁面時。不需要在每個欄位填寫前都 snapshot。
4. 每個步驟的 action 必須寫清楚：
   - 要操作的元素的確切文字、placeholder、aria-label
   - 要輸入什麼值（如果是變數用 {{variableName}}）
   - 操作類型：browser_click、browser_type、browser_select_option、browser_navigate 等
5. expectedState 要寫具體可驗證的狀態（例如「頁面出現文字 XXX」而非「頁面載入」）
6. selectors 盡量提供多個備選：CSS 選擇器、文字內容、ARIA 標籤
7. 不要使用 browser_take_screenshot，只用 browser_snapshot 確認頁面狀態
8. 目標：整個 playbook 控制在 15-20 步以內，避免浪費 token

每個步驟格式：
- id：步驟編號（從 1 開始）
- action：具體的單一操作指令，包含工具名稱與目標元素描述
- expectedState：操作完成後可驗證的具體頁面狀態
- selectors：建議的 CSS 選擇器、ARIA 標籤或元素文字描述（至少提供 2 個備選）
- onError：如果步驟失敗的備用做法

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
    { "id": 1, "action": "...", "expectedState": "...", "selectors": ["...", "..."], "onError": "..." }
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
