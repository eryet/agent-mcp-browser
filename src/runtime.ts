import {
  Agent,
  MCPServerStreamableHttp,
  connectMcpServers,
  type Tool,
} from "@openai/agents";

type RuntimeSetupInput = {
  mcpUrl: string;
  model: string;
  mcpTimeout: number;
  connectTimeout: number;
  instructions?: string;
};

export type ConnectedRuntime = {
  agent: Agent;
  close: () => Promise<void>;
};

export function getToolName(tool: Tool): string {
  if ("name" in tool && typeof tool.name === "string" && tool.name.length > 0) {
    return tool.name;
  }
  return "unknown_tool";
}

export function shorten(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}...`;
}

const DEFAULT_INSTRUCTIONS =
  "你是瀏覽器自動化助理。需要存取網頁內容時，必須優先使用可用的 MCP 工具，不要捏造內容。若呼叫 browser_take_screenshot，必須傳入相對檔名 filename（例如 screenshot-20260302-1530.png），不可使用絕對路徑。若動作涉及加入購物車、填寫個資、付款或提交訂單，必須先要求使用者明確確認，不可直接執行。回覆請簡潔且使用繁體中文。";

export async function connectRuntime({
  mcpUrl,
  model,
  mcpTimeout,
  connectTimeout,
  instructions,
}: RuntimeSetupInput): Promise<ConnectedRuntime> {
  const server = new MCPServerStreamableHttp({
    name: "playwright-mcp",
    url: mcpUrl,
    timeout: mcpTimeout,
    cacheToolsList: true,
  });

  const servers = await connectMcpServers([server], {
    strict: true,
    connectTimeoutMs: connectTimeout,
    closeTimeoutMs: 5_000,
  });

  if (servers.active.length === 0) {
    throw new Error(`MCP 伺服器連線失敗：${mcpUrl}`);
  }

  const agent = new Agent({
    name: "Playwright Browser Agent",
    model,
    instructions: instructions ?? DEFAULT_INSTRUCTIONS,
    mcpServers: servers.active,
  });

  return {
    agent,
    close: async () => {
      await servers.close();
    },
  };
}
