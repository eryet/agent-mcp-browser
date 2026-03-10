import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTaskFromArgs } from "./templates.js";

const DEFAULT_MCP_URL = "http://localhost:8931/mcp";
const DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_PLANNER_MODEL = "gpt-5.4";
const DEFAULT_MCP_MODE = "headless";
const DEFAULT_OUTPUT_DIR = "./playwright-mcp-output/";
const DEFAULT_PLAYBOOK_DIR = "./playbooks/";
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

type MCPMode = "headless" | "attach";
export type RunMode = "interactive" | "plan" | "playbook";

export type RuntimeConfig = {
  mcpUrl: string;
  model: string;
  mcpMode: MCPMode;
  mcpTimeout: number;
  connectTimeout: number;
  maxTurns: number;
  screenshotDir: string;
  initialTask?: string;
  runMode: RunMode;
  plannerModel: string;
  playbookPath?: string;
  playbookDir: string;
  variableOverrides: Record<string, string>;
};

export function ensureApiKey(): void {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("缺少 OPENAI_API_KEY，請先設定環境變數。");
  }
}

function readNumberFromEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (Number.isNaN(parsed)) {
    throw new Error(`環境變數 ${name} 不是有效數字：${rawValue}`);
  }

  return parsed;
}

function readMcpModeFromEnv(): MCPMode {
  const rawValue = process.env.MCP_MODE?.trim().toLowerCase();
  if (!rawValue) {
    return DEFAULT_MCP_MODE;
  }

  if (rawValue === "headless" || rawValue === "attach") {
    return rawValue;
  }

  throw new Error(`環境變數 MCP_MODE 僅支援 headless 或 attach：${rawValue}`);
}

function resolveScreenshotDir(rawPath: string): string {
  if (path.isAbsolute(rawPath)) {
    return path.normalize(rawPath);
  }

  return path.resolve(PROJECT_ROOT, rawPath);
}

function resolveScreenshotDirFromEnv(): string {
  const mcpOutputDir = process.env.PLAYWRIGHT_MCP_OUTPUT_DIR?.trim();
  if (mcpOutputDir) {
    return resolveScreenshotDir(mcpOutputDir);
  }

  return resolveScreenshotDir(DEFAULT_OUTPUT_DIR);
}

function resolvePlaybookDir(): string {
  const envDir = process.env.PLAYBOOK_DIR?.trim();
  const rawDir = envDir || DEFAULT_PLAYBOOK_DIR;

  if (path.isAbsolute(rawDir)) {
    return path.normalize(rawDir);
  }

  return path.resolve(PROJECT_ROOT, rawDir);
}

type PlaybookCliResult = {
  runMode: RunMode;
  playbookPath?: string;
  variableOverrides: Record<string, string>;
  remainingArgs: string[];
};

function parsePlaybookCliArgs(cliArgs: string[]): PlaybookCliResult {
  let runMode: RunMode = "interactive";
  let playbookPath: string | undefined;
  const variableOverrides: Record<string, string> = {};
  const remainingArgs: string[] = [];

  for (let i = 0; i < cliArgs.length; i++) {
    const arg = cliArgs[i];

    if (arg === "--plan") {
      runMode = "plan";
      continue;
    }

    if (arg === "--playbook") {
      runMode = "playbook";
      const nextArg = cliArgs[i + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        playbookPath = nextArg;
        i++;
      }
      continue;
    }

    if (arg === "--var") {
      const nextArg = cliArgs[i + 1];
      if (nextArg) {
        const eqIndex = nextArg.indexOf("=");
        if (eqIndex > 0) {
          variableOverrides[nextArg.slice(0, eqIndex)] =
            nextArg.slice(eqIndex + 1);
        }
        i++;
      }
      continue;
    }

    remainingArgs.push(arg);
  }

  return { runMode, playbookPath, variableOverrides, remainingArgs };
}

export function resolveRuntimeConfig(cliArgs: string[]): RuntimeConfig {
  const screenshotDir = resolveScreenshotDirFromEnv();
  const { runMode, playbookPath, variableOverrides, remainingArgs } =
    parsePlaybookCliArgs(cliArgs);

  const initialTask =
    remainingArgs.length > 0 ? resolveTaskFromArgs(remainingArgs) : undefined;

  return {
    mcpUrl: process.env.MCP_SERVER_URL ?? DEFAULT_MCP_URL,
    model: process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
    mcpMode: readMcpModeFromEnv(),
    mcpTimeout: readNumberFromEnv("MCP_TIMEOUT_MS", 20_000),
    connectTimeout: readNumberFromEnv("MCP_CONNECT_TIMEOUT_MS", 10_000),
    maxTurns: readNumberFromEnv("AGENT_MAX_TURNS", 12),
    screenshotDir,
    initialTask,
    runMode,
    plannerModel: process.env.OPENAI_PLANNER_MODEL ?? DEFAULT_PLANNER_MODEL,
    playbookPath,
    playbookDir: resolvePlaybookDir(),
    variableOverrides,
  };
}
