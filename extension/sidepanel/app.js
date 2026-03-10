/* global chrome */

const STORAGE_KEY = "playbooks";
const SETTINGS_KEY = "settings";
const DEFAULT_BACKEND_URL = "http://localhost:3001";

// ── State ──────────────────────────────────────────────

let playbooks = [];
let currentPlaybook = null;
let currentSessionId = null;
let backendUrl = DEFAULT_BACKEND_URL;
let pendingToolLines = [];

// ── DOM refs ───────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const views = {
  library: $("view-library"),
  settings: $("view-settings"),
  form: $("view-form"),
  execution: $("view-execution"),
};

const dom = {
  playbookList: $("playbook-list"),
  fileInput: $("file-input"),
  btnImport: $("btn-import"),
  btnSettings: $("btn-settings"),
  btnSettingsBack: $("btn-settings-back"),
  settingUrl: $("setting-backend-url"),
  btnSaveSettings: $("btn-save-settings"),
  connectionStatus: $("connection-status"),
  formTitle: $("form-title"),
  formDescription: $("form-description"),
  variableFields: $("variable-fields"),
  btnFormBack: $("btn-form-back"),
  btnExecute: $("btn-execute"),
  btnExecBack: $("btn-exec-back"),
  execProgressFill: $("exec-progress-fill"),
  execStatus: $("exec-status"),
  execLog: $("exec-log"),
  execResult: $("exec-result"),
  chatInputArea: $("chat-input-area"),
  chatInput: $("chat-input"),
  btnSend: $("btn-send"),
};

// ── View switching ─────────────────────────────────────

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle("active", key === name);
  }
}

// ── Storage helpers ────────────────────────────────────

async function loadPlaybooks() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  playbooks = data[STORAGE_KEY] || [];
}

async function savePlaybooks() {
  await chrome.storage.local.set({ [STORAGE_KEY]: playbooks });
}

async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = data[SETTINGS_KEY] || {};
  backendUrl = settings.backendUrl || DEFAULT_BACKEND_URL;
}

async function saveSettings() {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: { backendUrl },
  });
}

// ── Library rendering ──────────────────────────────────

function renderLibrary() {
  if (playbooks.length === 0) {
    dom.playbookList.innerHTML = `
      <div class="empty-state">
        <p>No playbooks yet.</p>
        <p>Click <strong>+ Import</strong> to add a playbook JSON file.</p>
      </div>`;
    return;
  }

  dom.playbookList.innerHTML = playbooks
    .map(
      (pb, i) => `
    <div class="playbook-card" data-index="${i}">
      <h3>${esc(pb.metadata?.name || "Untitled")}</h3>
      <div class="meta">
        ${esc(pb.metadata?.description || "")}
        &middot; ${pb.steps?.length || 0} steps
        &middot; ${Object.keys(pb.variables || {}).length} variables
      </div>
      <div class="actions">
        <button class="btn btn-primary" data-action="execute" data-index="${i}">Execute</button>
        <button class="btn btn-outline" data-action="delete" data-index="${i}">Delete</button>
      </div>
    </div>`
    )
    .join("");
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ── Import ─────────────────────────────────────────────

function handleImport() {
  dom.fileInput.click();
}

async function handleFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const pb = JSON.parse(text);

    if (!pb.metadata || !Array.isArray(pb.steps)) {
      alert("Invalid playbook: missing metadata or steps.");
      return;
    }

    playbooks.push(pb);
    await savePlaybooks();
    renderLibrary();
  } catch (err) {
    alert("Failed to parse JSON: " + err.message);
  }

  dom.fileInput.value = "";
}

// ── Delete ─────────────────────────────────────────────

async function handleDelete(index) {
  const name = playbooks[index]?.metadata?.name || "this playbook";
  if (!confirm(`Delete "${name}"?`)) return;

  playbooks.splice(index, 1);
  await savePlaybooks();
  renderLibrary();
}

// ── Variable Form ──────────────────────────────────────

function openVariableForm(index) {
  currentPlaybook = playbooks[index];
  if (!currentPlaybook) return;

  dom.formTitle.textContent = currentPlaybook.metadata?.name || "Variables";
  dom.formDescription.textContent =
    currentPlaybook.metadata?.description || "";

  const vars = currentPlaybook.variables || {};
  const varKeys = Object.keys(vars);

  if (varKeys.length === 0) {
    dom.variableFields.innerHTML =
      '<p style="color:#6b7280;padding:8px 0">No variables needed. Click Execute to run.</p>';
  } else {
    dom.variableFields.innerHTML = varKeys
      .map(
        (key) => `
      <label>
        ${esc(vars[key].description || key)}
        <input type="text" data-var="${esc(key)}" value="${esc(vars[key].default || "")}" />
      </label>`
      )
      .join("");
  }

  showView("form");
}

function collectVariables() {
  const inputs = dom.variableFields.querySelectorAll("input[data-var]");
  const variables = {};
  for (const input of inputs) {
    variables[input.dataset.var] = input.value;
  }
  return variables;
}

// ── Chat log helpers ───────────────────────────────────

function flushToolLines() {
  if (pendingToolLines.length === 0) return;

  const group = document.createElement("div");
  group.className = "tool-group";
  for (const { type, text } of pendingToolLines) {
    const line = document.createElement("div");
    line.className = `tool-line ${type}`;
    line.textContent = text;
    group.appendChild(line);
  }
  dom.execLog.appendChild(group);
  pendingToolLines = [];
  scrollLog();
}

function addChatBubble(role, text) {
  flushToolLines();
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${role}`;
  const label = document.createElement("div");
  label.className = "bubble-label";
  label.textContent = role === "agent" ? "Agent" : "You";
  bubble.appendChild(label);
  const content = document.createElement("div");
  content.textContent = text;
  bubble.appendChild(content);
  dom.execLog.appendChild(bubble);
  scrollLog();
}

function addToolLine(type, text) {
  pendingToolLines.push({ type, text });
}

function formatTokenCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function addUsageBadge(usage) {
  if (!usage) return;

  const badge = document.createElement("div");
  badge.className = "usage-badge";

  let html = `<div style="width:100%">`;

  // Turn usage
  html += `<div class="usage-row">`;
  html += `<span class="usage-section-label">Turn</span>`;
  html += `<span class="usage-item"><span class="usage-label">in:</span> <span class="usage-value">${formatTokenCount(usage.turnInputTokens)}</span></span>`;
  html += `<span class="usage-item"><span class="usage-label">out:</span> <span class="usage-value">${formatTokenCount(usage.turnOutputTokens)}</span></span>`;
  if (usage.requests) {
    html += `<span class="usage-item"><span class="usage-label">reqs:</span> <span class="usage-value">${usage.requests}</span></span>`;
  }
  if (usage.elapsed) {
    html += `<span class="usage-item"><span class="usage-label">time:</span> <span class="usage-value">${usage.elapsed}s</span></span>`;
  }
  html += `</div>`;

  // Cumulative usage
  html += `<div class="usage-divider"></div>`;
  html += `<div class="usage-row">`;
  html += `<span class="usage-section-label">Total</span>`;
  html += `<span class="usage-item"><span class="usage-label">in:</span> <span class="usage-value">${formatTokenCount(usage.totalInputTokens)}</span></span>`;
  html += `<span class="usage-item"><span class="usage-label">out:</span> <span class="usage-value">${formatTokenCount(usage.totalOutputTokens)}</span></span>`;
  html += `</div>`;

  html += `</div>`;
  badge.innerHTML = html;
  dom.execLog.appendChild(badge);
  scrollLog();
}

function scrollLog() {
  dom.execLog.scrollTop = dom.execLog.scrollHeight;
}

function showChatInput(show) {
  dom.chatInputArea.classList.toggle("hidden", !show);
  if (show) {
    dom.chatInput.focus();
  }
}

// ── Execution ──────────────────────────────────────────

async function startExecution() {
  if (!currentPlaybook) return;

  const variables = collectVariables();

  showView("execution");
  dom.execLog.innerHTML = "";
  dom.execResult.classList.add("hidden");
  dom.execResult.className = "exec-result hidden";
  dom.execProgressFill.style.width = "0%";
  dom.execStatus.textContent = "Connecting...";
  dom.btnExecBack.disabled = true;
  currentSessionId = null;
  pendingToolLines = [];
  showChatInput(false);

  let totalSteps = currentPlaybook.steps?.length || 1;

  try {
    const response = await fetch(`${backendUrl}/api/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playbook: currentPlaybook,
        variables,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}`);
    }

    await readSSEStream(response, totalSteps);
  } catch (err) {
    addChatBubble("agent", `Connection failed: ${err.message}`);
    dom.execStatus.textContent = "Failed";
    dom.btnExecBack.disabled = false;
  }
}

async function readSSEStream(response, totalSteps) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.totalSteps) totalSteps = event.totalSteps;
        handleSSEEvent(event, totalSteps);
      } catch {
        // skip malformed lines
      }
    }
  }

  // Stream ended — if session is still active, show chat input
  // (stream ends when server closes connection, e.g. on complete/error)
  dom.btnExecBack.disabled = false;
}

function handleSSEEvent(event, totalSteps) {
  switch (event.type) {
    case "connected":
      currentSessionId = event.sessionId;
      dom.execStatus.textContent = `Running... 0/${event.totalSteps} steps`;
      addChatBubble("agent", `Connected. ${event.totalSteps} steps to execute.`);
      break;

    case "tool_start":
      dom.execStatus.textContent = `Step ${event.step}/${totalSteps}: ${event.tool}`;
      dom.execProgressFill.style.width = `${(event.step / totalSteps) * 100}%`;
      addToolLine("start", `[${event.step}] ${event.tool} ...`);
      break;

    case "tool_end":
      addToolLine("end", `[${event.step}] ${event.tool} done`);
      break;

    case "agent_message":
      flushToolLines();
      dom.execStatus.textContent = `Waiting for input (${event.toolCalls} tool calls)`;
      addChatBubble("agent", event.message);
      addUsageBadge(event.usage);
      // Show chat input so user can reply
      showChatInput(true);
      dom.btnExecBack.disabled = false;
      break;

    case "user_message":
      // Echo from server — already shown locally, skip
      break;

    case "complete":
      flushToolLines();
      dom.execProgressFill.style.width = "100%";
      dom.execStatus.textContent = `Complete (${event.toolCalls} tool calls)`;
      addChatBubble("agent", event.finalOutput || "Done");
      showChatInput(false);
      currentSessionId = null;
      dom.btnExecBack.disabled = false;
      break;

    case "session_closed":
      showChatInput(false);
      currentSessionId = null;
      dom.btnExecBack.disabled = false;
      break;

    case "error":
      flushToolLines();
      dom.execStatus.textContent = "Error";
      addChatBubble("agent", `Error: ${event.message}`);
      showChatInput(true); // allow retry via chat
      dom.btnExecBack.disabled = false;
      break;
  }
}

// ── Send user message ──────────────────────────────────

async function sendUserMessage() {
  const message = dom.chatInput.value.trim();
  if (!message || !currentSessionId) return;

  dom.chatInput.value = "";
  addChatBubble("user", message);
  showChatInput(false);
  dom.execStatus.textContent = "Running...";
  dom.btnExecBack.disabled = true;

  try {
    const res = await fetch(
      `${backendUrl}/api/sessions/${currentSessionId}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      },
    );

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || `Server responded with ${res.status}`);
    }
    // SSE events will arrive via the still-open execute stream
  } catch (err) {
    addChatBubble("agent", `Send failed: ${err.message}`);
    showChatInput(true);
    dom.btnExecBack.disabled = false;
  }
}

// ── Settings ───────────────────────────────────────────

function openSettings() {
  dom.settingUrl.value = backendUrl;
  dom.connectionStatus.textContent = "Not checked";
  dom.connectionStatus.className = "status-badge";
  showView("settings");
}

async function saveSettingsHandler() {
  backendUrl = dom.settingUrl.value.trim() || DEFAULT_BACKEND_URL;
  await saveSettings();

  try {
    const res = await fetch(`${backendUrl}/api/health`);
    const data = await res.json();
    if (data.status === "ok") {
      dom.connectionStatus.textContent = "Connected";
      dom.connectionStatus.className = "status-badge ok";
    } else {
      throw new Error("Unexpected response");
    }
  } catch {
    dom.connectionStatus.textContent = "Cannot connect";
    dom.connectionStatus.className = "status-badge error";
  }
}

// ── Event listeners ────────────────────────────────────

dom.btnImport.addEventListener("click", handleImport);
dom.fileInput.addEventListener("change", handleFileSelected);
dom.btnSettings.addEventListener("click", openSettings);
dom.btnSettingsBack.addEventListener("click", () => showView("library"));
dom.btnSaveSettings.addEventListener("click", saveSettingsHandler);
dom.btnFormBack.addEventListener("click", () => showView("library"));
dom.btnExecute.addEventListener("click", startExecution);

dom.btnExecBack.addEventListener("click", async () => {
  if (currentSessionId) {
    try {
      await fetch(`${backendUrl}/api/sessions/${currentSessionId}/end`, {
        method: "POST",
      });
    } catch {
      // ignore
    }
  }
  currentSessionId = null;
  showChatInput(false);
  showView("library");
  currentPlaybook = null;
});

dom.btnSend.addEventListener("click", sendUserMessage);
dom.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendUserMessage();
  }
});

dom.playbookList.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;

  const index = Number(btn.dataset.index);
  if (btn.dataset.action === "execute") openVariableForm(index);
  if (btn.dataset.action === "delete") handleDelete(index);
});

// ── Init ───────────────────────────────────────────────

(async () => {
  await loadSettings();
  await loadPlaybooks();
  renderLibrary();
})();
