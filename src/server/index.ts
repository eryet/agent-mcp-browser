import "dotenv/config";
import http from "node:http";
import { parseExecuteRequest, executePlaybook, handleUserMessage, handleEndSession } from "./executor.js";

const PORT = Number(process.env.SERVER_PORT ?? "3001");

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    jsonResponse(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/execute") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      const body = await readBody(req);
      const request = parseExecuteRequest(body);
      await executePlaybook(request, res);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Server error";
      res.write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      res.end();
    }
    return;
  }

  // POST /api/sessions/:id/message — send user message to active session
  const messageMatch = url.pathname.match(
    /^\/api\/sessions\/([a-f0-9-]+)\/message$/,
  );
  if (req.method === "POST" && messageMatch) {
    try {
      const body = await readBody(req);
      const { message } = JSON.parse(body) as { message: string };

      if (!message || typeof message !== "string") {
        jsonResponse(res, 400, { error: "Missing message field" });
        return;
      }

      const result = await handleUserMessage(messageMatch[1], message);
      if (result.ok) {
        jsonResponse(res, 200, { ok: true });
      } else {
        jsonResponse(res, 404, { error: result.error });
      }
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Server error";
      jsonResponse(res, 500, { error: msg });
    }
    return;
  }

  // POST /api/sessions/:id/end — end a session
  const endMatch = url.pathname.match(
    /^\/api\/sessions\/([a-f0-9-]+)\/end$/,
  );
  if (req.method === "POST" && endMatch) {
    const result = await handleEndSession(endMatch[1]);
    if (result.ok) {
      jsonResponse(res, 200, { ok: true });
    } else {
      jsonResponse(res, 404, { error: result.error });
    }
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[server] Playbook API running on http://localhost:${PORT}`);
  console.log(`[server] Health check: http://localhost:${PORT}/api/health`);
  console.log(`[server] Execute endpoint: POST http://localhost:${PORT}/api/execute`);
  console.log(`[server] Message endpoint: POST http://localhost:${PORT}/api/sessions/:id/message`);
});
