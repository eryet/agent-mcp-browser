import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Agent, run } from "@openai/agents";
import { ScreenshotCollector } from "./screenshot.js";
import { sanitizeInvalidImageUrlsBeforeModelCall } from "./sanitize.js";

function formatFinalOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "(無輸出)";
  }

  return JSON.stringify(value, null, 2);
}

function buildTaskWithHistory(userInput: string, history: string[]): string {
  if (history.length === 0) {
    return userInput;
  }

  const recentHistory = history.slice(-8).join("\n");
  return [
    "請延續同一個對話與瀏覽器 session，並參考以下最近對話紀錄。",
    recentHistory,
    `使用者最新指令：${userInput}`,
  ].join("\n\n");
}

export async function runSingleTurn(
  agent: Agent,
  userInput: string,
  history: string[],
  maxTurns: number,
  screenshotCollector: ScreenshotCollector,
): Promise<void> {
  console.log(`[run] task: ${userInput}`);
  screenshotCollector.startTurn(userInput);

  const task = buildTaskWithHistory(userInput, history);
  const result = await run(agent, task, {
    maxTurns,
    callModelInputFilter: sanitizeInvalidImageUrlsBeforeModelCall,
  });
  const finalOutput = formatFinalOutput(result.finalOutput);

  console.log("\n=== Final Output ===");
  console.log(finalOutput);
  screenshotCollector.finishTurn();

  history.push(`使用者：${userInput}`);
  history.push(`助理：${finalOutput}`);
}

export async function startInteractiveSession(
  agent: Agent,
  initialTask: string | undefined,
  maxTurns: number,
  screenshotCollector: ScreenshotCollector,
): Promise<void> {
  const history: string[] = [];
  const rl = readline.createInterface({ input, output });
  let shouldExit = false;

  const handleSignal = () => {
    shouldExit = true;
    rl.close();
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    console.log("輸入 /exit 可離開。\n");

    if (initialTask) {
      try {
        await runSingleTurn(
          agent,
          initialTask,
          history,
          maxTurns,
          screenshotCollector,
        );
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error(`[error] 首輪任務失敗：${error.message}`);
        } else {
          console.error("[error] 首輪任務失敗", error);
        }
      }
    }

    while (!shouldExit) {
      const userInput = (await rl.question("You> ")).trim();

      if (!userInput) {
        continue;
      }

      if (userInput === "/exit") {
        break;
      }

      try {
        await runSingleTurn(
          agent,
          userInput,
          history,
          maxTurns,
          screenshotCollector,
        );
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error(`[error] 任務執行失敗：${error.message}`);
        } else {
          console.error("[error] 任務執行失敗", error);
        }
      }

      console.log();
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    rl.close();
  }
}
