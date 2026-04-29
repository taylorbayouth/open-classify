#!/usr/bin/env tsx
import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { loadConfig } from "./config.js";
import { classify } from "./classify.js";
import { computeRoute } from "./route.js";
import { buildTrace } from "./trace.js";
import { InputEnvelopeSchema, type Trace } from "./schema.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_TRACES = 500;

const config = loadConfig();
type AugmentedTrace = Trace & { _user_input: string; _new?: boolean };

const traces: AugmentedTrace[] = [];
const sseClients = new Set<ServerResponse>();

function broadcast(trace: AugmentedTrace): void {
  const data = `data: ${JSON.stringify(trace)}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

async function handleClassify(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let body: { user_input?: string };
  try {
    body = JSON.parse(await readBody(req)) as typeof body;
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!body.user_input?.trim()) {
    json(res, 400, { error: "user_input required" });
    return;
  }

  const envelope = InputEnvelopeSchema.parse({
    request_id: randomUUID(),
    user_input: body.user_input.trim(),
  });

  const classifyResult = await classify(envelope, config.classifier);
  const routeDecision = computeRoute(classifyResult.classification, config);

  const trace: AugmentedTrace = {
    ...buildTrace({
      request_id: envelope.request_id,
      user_input: envelope.user_input,
      classifier_model: config.classifier.model,
      classifier_latency_ms: classifyResult.latency_ms,
      classifier_output: classifyResult.classification,
      validation_status: classifyResult.validation_status,
      route_decision: routeDecision,
      fallback_used: classifyResult.fallback_used,
    }),
    _user_input: envelope.user_input,
    _new: true,
  };

  traces.unshift(trace);
  if (traces.length > MAX_TRACES) traces.pop();
  broadcast(trace);

  json(res, 200, { classification: classifyResult.classification, route_decision: routeDecision });
}

function handleStream(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(":\n\n"); // keep-alive comment

  // Send existing traces on connect (oldest first, no animation flag)
  for (const t of [...traces].reverse()) {
    const { _new: _, ...rest } = t;
    res.write(`data: ${JSON.stringify(rest)}\n\n`);
  }

  sseClients.add(res);
  res.on("close", () => sseClients.delete(res));
}

function handleFrontend(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(FRONTEND_HTML);
}

const server = createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
    res.end();
    return;
  }

  if (method === "POST" && url === "/classify") {
    await handleClassify(req, res);
  } else if (method === "GET" && url === "/stream") {
    handleStream(res);
  } else if (method === "GET" && url === "/traces") {
    json(res, 200, traces);
  } else if (method === "GET" && (url === "/" || url === "/index.html")) {
    handleFrontend(res);
  } else {
    json(res, 404, { error: "Not found" });
  }
});

server.listen(PORT, () => {
  console.log(`llm-harness running at http://localhost:${PORT}`);
  console.log(`Classifier model: ${config.classifier.model}`);
});

// ─── Frontend ───────────────────────────────────────────────────────────────

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LLM Harness</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --border: #2a2d3a;
    --text: #e2e8f0;
    --muted: #64748b;
    --green: #22c55e;
    --amber: #f59e0b;
    --red: #ef4444;
    --blue: #3b82f6;
    --purple: #a855f7;
    --teal: #14b8a6;
    --font: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.5;
    min-height: 100vh;
  }

  header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 16px;
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 10;
  }

  header h1 {
    font-size: 14px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  #count {
    color: var(--muted);
    font-size: 12px;
  }

  #status {
    margin-left: auto;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  #status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted);
  }

  #status-dot.connected { background: var(--green); }
  #status-dot.error { background: var(--red); }

  .input-bar {
    padding: 12px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .input-bar input[type="text"] {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    color: var(--text);
    font-family: var(--font);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }

  .input-bar input[type="text"]:focus {
    border-color: var(--blue);
  }

  .input-bar button {
    background: var(--blue);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    font-family: var(--font);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: opacity 0.15s;
  }

  .input-bar button:hover { opacity: 0.85; }
  .input-bar button:disabled { opacity: 0.4; cursor: default; }

.table-wrap {
    overflow-x: auto;
    padding: 0 24px 24px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 16px;
  }

  thead th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  tbody tr {
    border-bottom: 1px solid var(--border);
    transition: background 0.1s;
  }

  tbody tr:hover { background: var(--surface); }

  tbody tr.new-row {
    animation: flash 0.6s ease-out;
  }

  @keyframes flash {
    from { background: rgba(59, 130, 246, 0.15); }
    to { background: transparent; }
  }

  td {
    padding: 8px 10px;
    vertical-align: middle;
    max-width: 0;
  }

  td.input-cell {
    max-width: 280px;
    width: 280px;
  }

  .input-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    cursor: help;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
  }

  .task-chat     { background: #1e293b; color: #94a3b8; }
  .task-writing  { background: #1e3a5f; color: #60a5fa; }
  .task-code     { background: #1a2e1a; color: #4ade80; }
  .task-research { background: #2d1f3d; color: #c084fc; }
  .task-tool_action { background: #2d2000; color: #fbbf24; }
  .task-planning { background: #1f2d2d; color: #2dd4bf; }
  .task-unknown  { background: #2d1f1f; color: #f87171; }

  .risk-low    { background: #14291f; color: var(--green); }
  .risk-medium { background: #2d200a; color: var(--amber); }
  .risk-high   { background: #2d0f0f; color: var(--red); }

  .route-cheap           { background: #14291f; color: var(--green); }
  .route-default         { background: #1e293b; color: #94a3b8; }
  .route-frontier        { background: #2d1f3d; color: #c084fc; }
  .route-web             { background: #1e2d4f; color: #60a5fa; }
  .route-private_context { background: #1f2d1f; color: var(--teal); }
  .route-confirm_side_effect { background: #2d200a; color: var(--amber); }
  .route-reject_or_escalate  { background: #2d0f0f; color: var(--red); }
  .route-fallback        { background: #2d0f0f; color: var(--red); }

  .tier-local    { color: var(--green); }
  .tier-mini     { color: var(--blue); }
  .tier-frontier { color: var(--purple); }

  .flag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 10px;
  }

  .flag-on  { background: rgba(245, 158, 11, 0.15); color: var(--amber); }
  .flag-off { color: #374151; }

  .conf-bar {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .conf-track {
    width: 48px;
    height: 4px;
    background: #1e293b;
    border-radius: 2px;
    overflow: hidden;
  }

  .conf-fill {
    height: 100%;
    border-radius: 2px;
    background: var(--blue);
    transition: width 0.3s;
  }

  .conf-num { color: var(--muted); font-size: 11px; min-width: 28px; }

  .latency { color: var(--muted); font-size: 11px; }
  .latency.slow { color: var(--amber); }
  .latency.very-slow { color: var(--red); }

  .time { color: var(--muted); font-size: 10px; white-space: nowrap; }

  .fallback-badge {
    font-size: 10px;
    color: var(--red);
    margin-left: 4px;
  }

  .reason-cell {
    max-width: 200px;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: help;
  }

  #empty {
    padding: 60px 0;
    text-align: center;
    color: var(--muted);
    font-size: 12px;
  }
</style>
</head>
<body>

<header>
  <h1>LLM Harness</h1>
  <span id="count">0 traces</span>
  <div id="status">
    <div id="status-dot"></div>
    <span id="status-text">connecting…</span>
  </div>
</header>

<div class="input-bar">
  <input type="text" id="input" placeholder="Enter a request to classify…" autocomplete="off" />
  <button id="submit-btn" onclick="submitClassify()">Classify</button>
</div>

<div class="table-wrap">
  <div id="empty">No traces yet — submit a request above or send to POST /classify</div>
  <table id="table" style="display:none">
    <thead>
      <tr>
        <th>Time</th>
        <th style="width:280px">Input</th>
        <th>Task</th>
        <th>Flags</th>
        <th>Risk</th>
        <th>Conf</th>
        <th>Route</th>
        <th>Tier</th>
        <th>ms</th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody id="tbody"></tbody>
  </table>
</div>

<script>
  let traceCount = 0;

  const input = document.getElementById('input');
  const submitBtn = document.getElementById('submit-btn');
  const tbody = document.getElementById('tbody');
  const table = document.getElementById('table');
  const empty = document.getElementById('empty');
  const countEl = document.getElementById('count');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitClassify();
  });

  async function submitClassify() {
    const val = input.value.trim();
    if (!val) return;
    submitBtn.disabled = true;
    try {
      await fetch('/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_input: val }),
      });
      input.value = '';
    } catch(e) {
      console.error(e);
    } finally {
      submitBtn.disabled = false;
      input.focus();
    }
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function taskPill(cls) {
    return \`<span class="pill task-\${cls}">\${cls}</span>\`;
  }

  function riskPill(r) {
    return \`<span class="pill risk-\${r}">\${r}</span>\`;
  }

  function routePill(r) {
    return \`<span class="pill route-\${r}">\${r.replace(/_/g,' ')}</span>\`;
  }

  function tierSpan(t) {
    return \`<span class="tier-\${t}">\${t}</span>\`;
  }

  function flagCell(freshInfo, privateCtx, sideEffect) {
    const f = (on, label) => \`<span class="flag \${on ? 'flag-on' : 'flag-off'}">\${label}</span>\`;
    return f(freshInfo, 'fresh') + ' ' + f(privateCtx, 'priv') + ' ' + f(sideEffect, 'fx');
  }

  function confCell(c) {
    const pct = Math.round(c * 100);
    const color = c >= 0.8 ? '#22c55e' : c >= 0.6 ? '#3b82f6' : '#f59e0b';
    return \`<div class="conf-bar">
      <div class="conf-track"><div class="conf-fill" style="width:\${pct}%;background:\${color}"></div></div>
      <span class="conf-num">\${pct}%</span>
    </div>\`;
  }

  function latencyCell(ms) {
    const cls = ms > 1500 ? 'very-slow' : ms > 800 ? 'slow' : '';
    return \`<span class="latency \${cls}">\${ms}</span>\`;
  }

  function addRow(trace, animate) {
    const c = trace.classifier_output;
    const r = trace.route_decision;
    const isFallback = trace.fallback_used;

    const row = document.createElement('tr');
    if (animate) row.classList.add('new-row');

    const inputTrunc = trace.input_hash; // we don't have original input in trace
    // We'll store it via a custom field if available
    const inputText = trace._user_input || '(redacted)';

    row.innerHTML = \`
      <td class="time">\${fmtTime(trace.timestamp)}</td>
      <td class="input-cell"><div class="input-text" title="\${inputText.replace(/"/g,'&quot;')}">\${inputText}</div></td>
      <td>\${c ? taskPill(c.task_class) : '<span class="pill task-unknown">—</span>'}\${isFallback ? '<span class="fallback-badge">↯</span>' : ''}</td>
      <td>\${c ? flagCell(c.needs_fresh_info, c.needs_private_context, c.needs_side_effect_tool) : '—'}</td>
      <td>\${c ? riskPill(c.risk) : '—'}</td>
      <td>\${c ? confCell(c.confidence) : '—'}</td>
      <td>\${routePill(r.route)}</td>
      <td>\${tierSpan(r.model_tier)}</td>
      <td>\${latencyCell(trace.classifier_latency_ms)}</td>
      <td class="reason-cell" title="\${(c?.reason || '').replace(/"/g,'&quot;')}">\${c?.reason || '—'}</td>
    \`;

    tbody.prepend(row);
    traceCount++;
    countEl.textContent = traceCount + ' trace' + (traceCount === 1 ? '' : 's');
    empty.style.display = 'none';
    table.style.display = '';
  }

  // SSE connection
  function connect() {
    const es = new EventSource('/stream');

    es.onopen = () => {
      statusDot.className = 'connected';
      statusText.textContent = 'live';
    };

    es.onmessage = (e) => {
      const trace = JSON.parse(e.data);
      // First batch (existing traces) comes without animation
      const isNew = traceCount > 0 || trace._new;
      addRow(trace, !!trace._new);
    };

    es.onerror = () => {
      statusDot.className = 'error';
      statusText.textContent = 'reconnecting…';
    };
  }

  connect();
</script>
</body>
</html>`;
