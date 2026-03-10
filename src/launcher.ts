import "dotenv/config";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

const DEFAULT_MCP_URL = "http://localhost:8931/mcp";
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_INTERVAL_MS = 1_000;

type LauncherArgs = {
  verbose: boolean;
  passthroughArgs: string[];
};

function parseLauncherArgs(rawArgs: string[]): LauncherArgs {
  let verbose = false;
  const passthroughArgs: string[] = [];

  for (const argument of rawArgs) {
    if (argument === "--verbose") {
      verbose = true;
      continue;
    }

    passthroughArgs.push(argument);
  }

  return { verbose, passthroughArgs };
}

function resolveMcpEndpoint(): { host: string; port: number; mcpUrl: string } {
  const mcpUrl = process.env.MCP_SERVER_URL ?? DEFAULT_MCP_URL;
  const parsedUrl = new URL(mcpUrl);
  const fallbackPort = parsedUrl.protocol === "https:" ? 443 : 80;

  return {
    host: parsedUrl.hostname,
    port: parsedUrl.port ? Number(parsedUrl.port) : fallbackPort,
    mcpUrl,
  };
}

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });

    const onSuccess = (): void => {
      socket.destroy();
      resolve(true);
    };

    const onFailure = (): void => {
      socket.destroy();
      resolve(false);
    };

    socket.once("connect", onSuccess);
    socket.once("error", onFailure);
    socket.setTimeout(1_500, onFailure);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForMcpReady(
  host: string,
  port: number,
  timeoutMs: number,
  isAttachAlive: () => boolean,
  verbose: boolean,
): Promise<void> {
  const startedAt = Date.now();
  let attempts = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;

    if (!isAttachAlive()) {
      throw new Error("Attach MCP server 在就緒前已結束。請檢查上方錯誤訊息。");
    }

    if (await isPortOpen(host, port)) {
      if (verbose) {
        const elapsed = Date.now() - startedAt;
        console.log(
          `[launcher:verbose] MCP readiness check success in ${elapsed}ms (attempt=${attempts})`,
        );
      }
      return;
    }

    if (verbose) {
      const elapsed = Date.now() - startedAt;
      console.log(
        `[launcher:verbose] waiting MCP port ${host}:${port} ... elapsed=${elapsed}ms attempt=${attempts}`,
      );
    }

    await delay(DEFAULT_RETRY_INTERVAL_MS);
  }

  throw new Error(
    `等待 Attach MCP server 逾時（${timeoutMs}ms）。請確認 extension 已完成授權且 port ${port} 可用。`,
  );
}

function spawnPnpmScript(
  scriptName: string,
  extraArgs: string[] = [],
): ChildProcess {
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = ["run", scriptName, ...extraArgs];

  return spawn(pnpmCommand, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
}

function toExitCode(code: number | null): number {
  return typeof code === "number" ? code : 1;
}

async function main(): Promise<void> {
  const { verbose, passthroughArgs } = parseLauncherArgs(process.argv.slice(2));
  const { host, port, mcpUrl } = resolveMcpEndpoint();

  console.log("[launcher] 啟動 Attach MCP server...");
  if (verbose) {
    console.log(
      `[launcher:verbose] config mcpUrl=${mcpUrl} host=${host} port=${port} timeoutMs=${DEFAULT_WAIT_TIMEOUT_MS}`,
    );
  }
  const attachProcess = spawnPnpmScript("mcp:server:attach");

  let replProcess: ChildProcess | null = null;
  let shuttingDown = false;

  const shutdown = (signal?: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    if (replProcess && !replProcess.killed) {
      replProcess.kill(signal ?? "SIGTERM");
    }

    if (!attachProcess.killed) {
      attachProcess.kill(signal ?? "SIGTERM");
    }
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  attachProcess.once("error", (error) => {
    console.error("[launcher] 無法啟動 attach server:", error);
    process.exitCode = 1;
    shutdown("SIGTERM");
  });

  try {
    console.log(`[launcher] 等待 MCP server 就緒：${mcpUrl}`);
    await waitForMcpReady(
      host,
      port,
      DEFAULT_WAIT_TIMEOUT_MS,
      () => !attachProcess.killed && attachProcess.exitCode === null,
      verbose,
    );

    console.log("[launcher] MCP server 已就緒，啟動 REPL...");
    const replArgs =
      passthroughArgs.length > 0 ? ["--", ...passthroughArgs] : [];
    replProcess = spawnPnpmScript("start", replArgs);

    const replExitCode = await new Promise<number>((resolve) => {
      replProcess?.once("exit", (code) => {
        resolve(toExitCode(code));
      });

      replProcess?.once("error", (error) => {
        console.error("[launcher] 無法啟動 REPL:", error);
        resolve(1);
      });
    });

    process.exitCode = replExitCode;
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`[launcher] ${error.message}`);
    } else {
      console.error("[launcher] 啟動失敗", error);
    }
    process.exitCode = 1;
  } finally {
    shutdown("SIGTERM");

    await new Promise<void>((resolve) => {
      if (attachProcess.exitCode !== null || attachProcess.killed) {
        resolve();
        return;
      }

      attachProcess.once("exit", () => resolve());
      setTimeout(() => {
        if (!attachProcess.killed) {
          attachProcess.kill("SIGKILL");
        }
        resolve();
      }, 3_000);
    });
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    console.error(`[launcher] ${error.message}`);
  } else {
    console.error("[launcher] 未知錯誤", error);
  }
  process.exitCode = 1;
});
