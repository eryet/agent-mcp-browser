# Chrome Extension Side Panel & Backend API

## Overview

This document describes the Chrome extension and backend API server added to the agent-mcp-browser project. The system allows non-technical users to import, configure, and execute browser automation playbooks entirely from Chrome's Side Panel — no terminal required.

## Architecture

```
Chrome Extension (Side Panel)          Backend API Server (localhost:3001)
+-------------------------+           +------------------------------+
| Import playbook JSON    |           | POST /api/execute            |
| Render variable form    |---------->| -> substituteVariables()     |
| Show step progress      |<----------| -> connectRuntime()          |
| Multi-turn chat         |   SSE     | -> run(agent, prompt)        |
| Token usage display     |           | -> stream progress back      |
|                         |           |                              |
| Storage: chrome.storage |           | POST /api/sessions/:id/message|
+-------------------------+           | POST /api/sessions/:id/end   |
                                      | GET  /api/health             |
                                      |                              |
                                      | Connects to:                 |
                                      | - OpenAI API (gpt-5-mini)    |
                                      | - Playwright MCP (:8931)     |
                                      +------------------------------+
```

## File Structure

### Extension (`extension/`)

```
extension/
├── manifest.json              # Manifest V3, sidePanel + storage permissions
├── background.js              # Service worker (opens side panel on icon click)
├── sidepanel/
│   ├── index.html             # Side panel HTML (4 views: library, settings, form, execution)
│   ├── style.css              # All styling including chat bubbles, usage badges
│   └── app.js                 # UI logic — vanilla JS, no framework
└── icons/
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

### Backend Server (`src/server/`)

```
src/server/
├── index.ts                   # HTTP server (Node built-in http module), CORS, routing
└── executor.ts                # Session-based playbook execution, SSE streaming, token logging
```

---

## Backend API Endpoints

### `GET /api/health`

Health check endpoint for the extension to verify the backend is running.

**Response:**
```json
{ "status": "ok" }
```

### `POST /api/execute`

Start a playbook execution session. Returns an SSE stream that stays open for multi-turn interaction.

**Request body:**
```json
{
  "playbook": {
    "version": "1",
    "metadata": { "name": "...", "description": "..." },
    "variables": {
      "varName": { "description": "...", "default": "..." }
    },
    "steps": [
      { "id": 1, "action": "...", "expectedState": "...", "selectors": ["..."], "onError": "..." }
    ]
  },
  "variables": {
    "varName": "actual value"
  }
}
```

**SSE event types:**

| Event Type | Fields | Description |
|---|---|---|
| `connected` | `sessionId`, `totalSteps`, `description` | Session created, execution starting |
| `tool_start` | `step`, `tool` | Agent calling a browser tool |
| `tool_end` | `step`, `tool`, `result` | Tool call completed (result truncated to 200 chars) |
| `agent_message` | `message`, `toolCalls`, `usage` | Agent produced a text response; SSE stays open for chat |
| `user_message` | `message` | Echo of user message (sent via `/api/sessions/:id/message`) |
| `complete` | `finalOutput`, `toolCalls` | Execution finished |
| `session_closed` | — | Session cleaned up |
| `error` | `message` | Error occurred |

**Usage object in `agent_message`:**
```json
{
  "turnInputTokens": 5923,
  "turnOutputTokens": 1418,
  "totalInputTokens": 12500,
  "totalOutputTokens": 3200,
  "requests": 3,
  "elapsed": "12.5",
  "requestBreakdown": [
    {
      "request": 1,
      "inputTokens": 1523,
      "outputTokens": 842,
      "totalTokens": 2365,
      "endpoint": "responses.create",
      "inputDetails": { "cached_tokens": 1200 },
      "outputDetails": {}
    }
  ]
}
```

### `POST /api/sessions/:id/message`

Send a user message to an active session for multi-turn conversation.

**Request body:**
```json
{ "message": "user reply text" }
```

**Response:**
```json
{ "ok": true }
```

The agent's reply arrives via the still-open SSE stream from `/api/execute`.

### `POST /api/sessions/:id/end`

Gracefully end a session and close the SSE connection.

**Response:**
```json
{ "ok": true }
```

---

## Session Management

- Sessions are stored in-memory using `Map<sessionId, Session>`
- Each session holds: MCP runtime connection, conversation history, SSE response stream, token usage counters
- Sessions auto-expire after **30 minutes** (checked every 60 seconds)
- Sessions clean up on client disconnect (SSE `close` event)
- Conversation history is preserved between turns using `result.history` from the OpenAI Agents SDK
- Image content (screenshots) is stripped from history before replay to avoid OpenAI API `image_url` validation errors

---

## Extension UI Views

### 1. Library View
- Lists all imported playbooks with name, description, step count, variable count
- **Import** button: file picker for `.json` playbook files
- **Execute** button per playbook: opens variable form
- **Delete** button per playbook: removes from chrome.storage
- **Settings** gear icon: opens settings view

### 2. Settings View
- Backend URL input (default: `http://localhost:3001`)
- **Save** button: persists to chrome.storage and tests connection via `/api/health`
- Connection status badge: shows "Connected" (green) or "Cannot connect" (red)

### 3. Variable Form View
- Auto-rendered from `playbook.variables` definitions
- Text input per variable, labeled with description, pre-filled with default value
- **Execute** button: starts execution with filled-in variable values
- **Back** button: returns to library

### 4. Execution View
- **Progress bar**: visual indicator of currentStep / totalSteps
- **Status line**: shows current tool being called or waiting state
- **Chat log area**: scrollable area with:
  - Agent messages (white bubbles, left-aligned)
  - User messages (blue bubbles, right-aligned)
  - Tool call groups (compact monospace lines)
  - Token usage badges (blue info boxes after each agent turn)
- **Chat input**: text field + send button, shown when agent is waiting for user input
- **Back** button: ends session and returns to library

---

## Token Usage Logging

### Server-side (terminal output)

Each agent turn logs a detailed breakdown:

```
[session:a1b2c3d4] ── Turn Summary ──────────────────
  Model: gpt-5-mini | API Requests: 3 | Elapsed: 12.5s
  Request 1: 1523 in / 842 out (2365 total) [responses.create] | input(cached_tokens=1200)
  Request 2: 2100 in / 156 out (2256 total) [responses.create]
  Request 3: 2300 in / 420 out (2720 total) [responses.create]
  Turn total: 5923 in / 1418 out
  Cumulative: 5923 in / 1418 out | Tool calls: 8
───────────────────────────────────────────────
```

### Client-side (extension UI)

After each agent message, a compact usage badge displays:
- **Turn**: input tokens, output tokens, API request count, elapsed time
- **Total**: cumulative input/output tokens across all turns in the session

---

## Key Implementation Details

### Multi-turn Conversation Flow

1. `POST /api/execute` creates a session and starts the first agent turn
2. Agent runs, calls browser tools (streamed via SSE), then produces a text response
3. SSE connection stays open; extension shows chat input
4. User types a reply -> `POST /api/sessions/:id/message`
5. Server sanitizes history (strips images), appends user message, runs next agent turn
6. Repeat until user clicks Back or session expires

### Image Sanitization (`sanitizeHistory`)

The OpenAI API rejects local file paths and base64 data as `image_url` values when replaying conversation history. The `sanitizeHistory` function:
- Filters out `type: "image"` and `type: "input_image"` entries from history items
- Replaces all-image items with a `[screenshot taken]` text placeholder
- Applied before every multi-turn continuation

### Screenshot Prevention

The `EXECUTOR_INSTRUCTIONS` explicitly prohibit `browser_take_screenshot` (which returns image data that breaks the API) and instruct the agent to use `browser_snapshot` instead (returns text-based accessibility tree).

---

## Planner Improvements

The `PLANNER_INSTRUCTIONS` in `src/planner.ts` were tuned for balanced playbook generation:

- **Auth flows**: detailed, one action per step (login, OAuth, tab switching)
- **Form fills**: combined — multiple fields in one step with bullet list
- **Snapshots**: only at key transitions (page navigation, after login, new page)
- **Target**: 15-20 steps per playbook to optimize token usage
- **Selectors**: at least 2 alternatives per step (CSS, text, ARIA)
- **No screenshots**: only `browser_snapshot` for page state verification

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | OpenAI API key (required) |
| `OPENAI_MODEL` | `gpt-5-mini` | Model for playbook execution |
| `OPENAI_PLANNER_MODEL` | `gpt-5.4` | Model for playbook planning |
| `MCP_SERVER_URL` | `http://localhost:8931/mcp` | Playwright MCP server URL |
| `MCP_TIMEOUT_MS` | `20000` | MCP tool call timeout |
| `MCP_CONNECT_TIMEOUT_MS` | `10000` | MCP connection timeout |
| `AGENT_MAX_TURNS` | `12` | Max agent turns per execution |
| `SERVER_PORT` | `3001` | Backend API server port |
| `PLAYBOOK_DIR` | `./playbooks/` | Directory for saved playbooks |

---

## How to Run

### 1. Start Playwright MCP Server

```bash
# Headless mode
pnpm run mcp:server

# Or attach to existing Chrome (recommended for auth flows)
pnpm run mcp:server:attach
```

### 2. Start Backend API Server

```bash
pnpm run server
# Output: [server] Playbook API running on http://localhost:3001
```

### 3. Load Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** -> select the `extension/` folder
4. Click the extension icon to open the Side Panel

### 4. Execute a Playbook

1. Click **+ Import** in the Side Panel
2. Select a playbook JSON file (from `playbooks/` directory)
3. Fill in variables (pre-filled with defaults)
4. Click **Execute**
5. Watch progress in real-time; reply to agent questions via chat input

---

## Model Pricing Reference (Standard Tier)

| Model | Input/1M tokens | Output/1M tokens | Use Case |
|---|---|---|---|
| `gpt-4.1-nano` | $0.10 | $0.40 | Budget executor |
| `gpt-4o-mini` | $0.15 | $0.60 | Legacy option |
| `gpt-5-mini` | $0.25 | $2.00 | Current executor (balanced) |
| `gpt-4.1-mini` | $0.40 | $1.60 | Previous executor |
| `gpt-5` | $1.25 | $10.00 | — |
| `gpt-5.4` | — | — | Current planner |
