import type { ServerResponse } from "node:http";
import crypto from "node:crypto";
import { run, type AgentInputItem } from "@openai/agents";
import { connectRuntime, getToolName, shorten, type ConnectedRuntime } from "../runtime.js";
import {
  type Playbook,
  substituteVariables,
  formatPlaybookAsTaskPrompt,
  EXECUTOR_INSTRUCTIONS,
} from "../playbook.js";

type ExecuteRequest = {
  playbook: Playbook;
  variables: Record<string, string>;
};

type Session = {
  id: string;
  runtime: ConnectedRuntime;
  history: AgentInputItem[];
  res: ServerResponse;
  toolCallCount: number;
  totalSteps: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: number;
};

const sessions = new Map<string, Session>();

// Clean up stale sessions after 30 minutes
const SESSION_TTL_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      cleanupSession(id);
    }
  }
}, 60_000);

async function cleanupSession(id: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  try {
    await session.runtime.close();
  } catch {
    // ignore cleanup errors
  }
  if (session.res.writable) {
    sendSSE(session.res, { type: "session_closed" });
    session.res.end();
  }
}

function sendSSE(
  res: ServerResponse,
  data: Record<string, unknown>,
): void {
  if (!res.writable) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function parseExecuteRequest(body: string): ExecuteRequest {
  const parsed = JSON.parse(body) as ExecuteRequest;

  if (!parsed.playbook || !Array.isArray(parsed.playbook.steps)) {
    throw new Error("Invalid request: missing playbook or steps");
  }

  return {
    playbook: parsed.playbook,
    variables: parsed.variables ?? {},
  };
}

export async function executePlaybook(
  request: ExecuteRequest,
  res: ServerResponse,
): Promise<void> {
  const mcpUrl = process.env.MCP_SERVER_URL ?? "http://localhost:8931/mcp";
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const mcpTimeout = Number(process.env.MCP_TIMEOUT_MS ?? "20000");
  const connectTimeout = Number(process.env.MCP_CONNECT_TIMEOUT_MS ?? "10000");
  const maxTurns = Number(process.env.AGENT_MAX_TURNS ?? "12");

  const playbook = substituteVariables(request.playbook, request.variables);
  const taskPrompt = formatPlaybookAsTaskPrompt(playbook);

  const sessionId = crypto.randomUUID();

  sendSSE(res, {
    type: "connected",
    sessionId,
    totalSteps: playbook.steps.length,
    description: playbook.metadata.description,
  });

  const runtime = await connectRuntime({
    mcpUrl,
    model,
    mcpTimeout,
    connectTimeout,
    instructions: EXECUTOR_INSTRUCTIONS,
  });

  const session: Session = {
    id: sessionId,
    runtime,
    history: [],
    res,
    toolCallCount: 0,
    totalSteps: playbook.steps.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    createdAt: Date.now(),
  };

  sessions.set(sessionId, session);

  // Clean up on client disconnect
  res.on("close", () => {
    cleanupSession(sessionId);
  });

  await runAgentTurn(session, taskPrompt, maxTurns);
}

async function runAgentTurn(
  session: Session,
  input: string | AgentInputItem[],
  maxTurns?: number,
): Promise<void> {
  const effectiveMaxTurns =
    maxTurns ?? Number(process.env.AGENT_MAX_TURNS ?? "12");

  const toolStartHandler = (_context: unknown, tool: unknown) => {
    session.toolCallCount++;
    const toolName = getToolName(tool as import("@openai/agents").Tool);
    sendSSE(session.res, {
      type: "tool_start",
      step: session.toolCallCount,
      tool: toolName,
    });
  };

  const toolEndHandler = (
    _context: unknown,
    tool: unknown,
    result: string,
  ) => {
    const toolName = getToolName(tool as import("@openai/agents").Tool);
    sendSSE(session.res, {
      type: "tool_end",
      step: session.toolCallCount,
      tool: toolName,
      result: shorten(result, 200),
    });
  };

  session.runtime.agent.on("agent_tool_start", toolStartHandler);
  session.runtime.agent.on("agent_tool_end", toolEndHandler);

  try {
    const result = await run(session.runtime.agent, input, {
      maxTurns: effectiveMaxTurns,
    });

    // Store history for continuation
    session.history = result.history as AgentInputItem[];

    // Aggregate token usage from all raw responses in this turn
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    const requestBreakdown: Array<{
      request: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      endpoint?: string;
      inputDetails: Record<string, number>;
      outputDetails: Record<string, number>;
    }> = [];

    for (let i = 0; i < result.rawResponses.length; i++) {
      const resp = result.rawResponses[i];
      const u = resp.usage;
      turnInputTokens += u.inputTokens;
      turnOutputTokens += u.outputTokens;

      // Per-request breakdown for detailed logging
      const entry = {
        request: i + 1,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        totalTokens: u.totalTokens,
        endpoint: undefined as string | undefined,
        inputDetails: {} as Record<string, number>,
        outputDetails: {} as Record<string, number>,
      };

      // Extract per-request details if available
      if (u.requestUsageEntries && u.requestUsageEntries.length > 0) {
        const re = u.requestUsageEntries[0];
        entry.endpoint = re.endpoint;
        entry.inputDetails = re.inputTokensDetails;
        entry.outputDetails = re.outputTokensDetails;
      }

      requestBreakdown.push(entry);
    }

    session.totalInputTokens += turnInputTokens;
    session.totalOutputTokens += turnOutputTokens;

    const elapsed = ((Date.now() - session.createdAt) / 1000).toFixed(1);

    // Detailed per-request log
    console.log(
      `\n[session:${session.id.slice(0, 8)}] ── Turn Summary ──────────────────`,
    );
    console.log(
      `  Model: ${process.env.OPENAI_MODEL ?? "gpt-4.1-mini"} | API Requests: ${result.rawResponses.length} | Elapsed: ${elapsed}s`,
    );
    for (const r of requestBreakdown) {
      const details = [];
      if (Object.keys(r.inputDetails).length > 0) {
        details.push(
          `input(${Object.entries(r.inputDetails).map(([k, v]) => `${k}=${v}`).join(", ")})`,
        );
      }
      if (Object.keys(r.outputDetails).length > 0) {
        details.push(
          `output(${Object.entries(r.outputDetails).map(([k, v]) => `${k}=${v}`).join(", ")})`,
        );
      }
      const endpoint = r.endpoint ? ` [${r.endpoint}]` : "";
      const detailStr = details.length > 0 ? ` | ${details.join(" | ")}` : "";
      console.log(
        `  Request ${r.request}: ${r.inputTokens} in / ${r.outputTokens} out (${r.totalTokens} total)${endpoint}${detailStr}`,
      );
    }
    console.log(
      `  Turn total: ${turnInputTokens} in / ${turnOutputTokens} out`,
    );
    console.log(
      `  Cumulative: ${session.totalInputTokens} in / ${session.totalOutputTokens} out | Tool calls: ${session.toolCallCount}`,
    );
    console.log(
      `───────────────────────────────────────────────\n`,
    );

    const finalOutput =
      typeof result.finalOutput === "string"
        ? result.finalOutput
        : JSON.stringify(result.finalOutput);

    // Send as agent message (chat-style), keep connection open
    sendSSE(session.res, {
      type: "agent_message",
      message: finalOutput,
      toolCalls: session.toolCallCount,
      usage: {
        turnInputTokens,
        turnOutputTokens,
        totalInputTokens: session.totalInputTokens,
        totalOutputTokens: session.totalOutputTokens,
        requests: result.rawResponses.length,
        elapsed,
        requestBreakdown,
      },
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown execution error";
    sendSSE(session.res, { type: "error", message });
  } finally {
    session.runtime.agent.off("agent_tool_start", toolStartHandler);
    session.runtime.agent.off("agent_tool_end", toolEndHandler);
  }
}

/**
 * Strip image content from history items to avoid OpenAI API errors.
 * Screenshot tool results contain local file paths or base64 data that
 * the API rejects as invalid image_url values on replay.
 */
function sanitizeHistory(history: AgentInputItem[]): AgentInputItem[] {
  return history.map((item) => {
    // Only process items with array content (which may contain image entries)
    if (!("content" in item) || !Array.isArray(item.content)) {
      return item;
    }

    const filtered = (item.content as Array<Record<string, unknown>>).filter(
      (part) => {
        const type = part.type as string | undefined;
        return type !== "image" && type !== "input_image";
      },
    );

    // If all content was images, replace with a text placeholder
    if (filtered.length === 0) {
      return {
        ...item,
        content: [{ type: "input_text", text: "[screenshot taken]" }],
      } as AgentInputItem;
    }

    return { ...item, content: filtered } as AgentInputItem;
  });
}

export async function handleUserMessage(
  sessionId: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = sessions.get(sessionId);
  if (!session) {
    return { ok: false, error: "Session not found or expired" };
  }

  if (!session.res.writable) {
    cleanupSession(sessionId);
    return { ok: false, error: "SSE connection closed" };
  }

  // Echo user message back via SSE so UI stays in sync
  sendSSE(session.res, { type: "user_message", message });

  // Continue conversation: sanitize history (remove images) and append user message
  const continuationInput: AgentInputItem[] = [
    ...sanitizeHistory(session.history),
    { role: "user" as const, content: message },
  ];

  await runAgentTurn(session, continuationInput);
  return { ok: true };
}

export async function handleEndSession(
  sessionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const session = sessions.get(sessionId);
  if (!session) {
    return { ok: false, error: "Session not found" };
  }

  sendSSE(session.res, {
    type: "complete",
    finalOutput: "Session ended by user.",
    toolCalls: session.toolCallCount,
  });

  await cleanupSession(sessionId);
  return { ok: true };
}
