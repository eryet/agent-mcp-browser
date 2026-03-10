import "dotenv/config";
import { ensureApiKey, resolveRuntimeConfig, type RuntimeConfig } from "./config.js";
import { connectRuntime, getToolName, shorten } from "./runtime.js";
import { ScreenshotCollector } from "./screenshot.js";
import { startInteractiveSession, runSingleTurn } from "./session.js";
import { generatePlaybook } from "./planner.js";
import {
  loadPlaybook,
  substituteVariables,
  formatPlaybookAsTaskPrompt,
  EXECUTOR_INSTRUCTIONS,
} from "./playbook.js";

function attachToolEventListeners(
  runtime: Awaited<ReturnType<typeof connectRuntime>>,
  screenshotCollector: ScreenshotCollector,
): void {
  runtime.agent.on("agent_tool_start", (_context, tool) => {
    console.log(`[tool:start] ${getToolName(tool)}`);
  });

  runtime.agent.on("agent_tool_end", async (_context, tool, result) => {
    const toolName = getToolName(tool);
    console.log(`[tool:end] ${toolName} -> ${shorten(result)}`);
    await screenshotCollector.onToolEnd(toolName, result);
  });
}

async function runInteractiveMode(config: RuntimeConfig): Promise<void> {
  const runtime = await connectRuntime({
    mcpUrl: config.mcpUrl,
    model: config.model,
    mcpTimeout: config.mcpTimeout,
    connectTimeout: config.connectTimeout,
  });

  const screenshotCollector = new ScreenshotCollector(config.screenshotDir);
  attachToolEventListeners(runtime, screenshotCollector);

  try {
    console.log(`[mcp] mode: ${config.mcpMode}`);
    console.log(`[mcp] connected: ${config.mcpUrl}`);
    console.log(`[screenshot] output dir: ${config.screenshotDir}`);

    await startInteractiveSession(
      runtime.agent,
      config.initialTask,
      config.maxTurns,
      screenshotCollector,
    );
  } finally {
    await runtime.close();
  }
}

async function runPlanMode(config: RuntimeConfig): Promise<void> {
  const task = config.initialTask;
  if (!task) {
    throw new Error(
      "使用 --plan 時需要提供任務描述。例如：pnpm run dev -- --plan \"打開網站並填寫表單\"",
    );
  }

  await generatePlaybook(task, config);
}

async function runPlaybookMode(config: RuntimeConfig): Promise<void> {
  if (!config.playbookPath) {
    throw new Error(
      "使用 --playbook 時需要提供 playbook 檔案路徑。例如：pnpm run dev -- --playbook playbooks/my-task.json",
    );
  }

  console.log(`[playbook] 載入：${config.playbookPath}`);
  const rawPlaybook = await loadPlaybook(config.playbookPath);

  const playbook = substituteVariables(rawPlaybook, config.variableOverrides);
  const taskPrompt = formatPlaybookAsTaskPrompt(playbook);

  console.log(`[playbook] 任務：${playbook.metadata.description}`);
  console.log(`[playbook] 步驟數：${playbook.steps.length}`);
  console.log(`[playbook] 使用模型：${config.model}`);

  const runtime = await connectRuntime({
    mcpUrl: config.mcpUrl,
    model: config.model,
    mcpTimeout: config.mcpTimeout,
    connectTimeout: config.connectTimeout,
    instructions: EXECUTOR_INSTRUCTIONS,
  });

  const screenshotCollector = new ScreenshotCollector(config.screenshotDir);
  attachToolEventListeners(runtime, screenshotCollector);

  try {
    console.log(`[mcp] mode: ${config.mcpMode}`);
    console.log(`[mcp] connected: ${config.mcpUrl}\n`);

    await runSingleTurn(
      runtime.agent,
      taskPrompt,
      [],
      config.maxTurns,
      screenshotCollector,
    );
  } finally {
    await runtime.close();
  }
}

async function main(): Promise<void> {
  ensureApiKey();

  const cliArgs = process.argv.slice(2);
  const config = resolveRuntimeConfig(cliArgs);

  switch (config.runMode) {
    case "plan":
      await runPlanMode(config);
      break;
    case "playbook":
      await runPlaybookMode(config);
      break;
    default:
      await runInteractiveMode(config);
      break;
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`[error] ${error.message}`);
  } else {
    console.error("[error] 發生未知錯誤", error);
  }
  process.exitCode = 1;
});
