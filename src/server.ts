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
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(data));
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
      sub_latencies: classifyResult.classification ? classifyResult.sub_latencies : null,
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

  json(res, 200, {
    classification: classifyResult.classification,
    route_decision: routeDecision,
    sub_latencies: classifyResult.sub_latencies,
  });
}

function handleStream(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(":\n\n");

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
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
    });
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
  console.log(
    `Note: 5 parallel calls per classification. For Ollama, run with OLLAMA_NUM_PARALLEL=5 (or higher).`
  );
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
    --pink: #ec4899;
    --font: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 12px;
    line-height: 1.5;
    min-height: 100vh;
  }

  header {
    padding: 14px 20px;
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
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  #count { color: var(--muted); font-size: 11px; }

  #status { margin-left: auto; font-size: 11px; display: flex; align-items: center; gap: 6px; }
  #status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
  #status-dot.connected { background: var(--green); }
  #status-dot.error { background: var(--red); }

  .input-bar {
    padding: 10px 20px;
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
    font-size: 12px;
    outline: none;
  }

  .input-bar input[type="text"]:focus { border-color: var(--blue); }

  .input-bar button {
    background: var(--blue);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    font-family: var(--font);
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }

  .input-bar button:hover { opacity: 0.85; }
  .input-bar button:disabled { opacity: 0.4; cursor: default; }

  .table-wrap { overflow-x: auto; padding: 0 20px 20px; }

  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 16px;
    table-layout: fixed;
  }

  thead th {
    text-align: left;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  tbody tr {
    border-bottom: 1px solid var(--border);
  }

  tbody tr:hover { background: var(--surface); }

  tbody tr.new-row { animation: flash 0.6s ease-out; }
  @keyframes flash { from { background: rgba(59, 130, 246, 0.15); } to { background: transparent; } }

  td {
    padding: 8px;
    vertical-align: middle;
  }

  .input-cell {
    width: 22%;
  }

  .input-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: help;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    white-space: nowrap;
  }

  /* Task class */
  .tc-chat     { background: #1e293b; color: #94a3b8; }
  .tc-draft    { background: #1e3a5f; color: #60a5fa; }
  .tc-code     { background: #1a2e1a; color: #4ade80; }
  .tc-research { background: #2d1f3d; color: #c084fc; }
  .tc-unknown  { background: #2d1f1f; color: #f87171; }

  /* Memory */
  .mem-none      { background: #1e293b; color: #64748b; }
  .mem-recent    { background: #1f2d2d; color: #2dd4bf; }
  .mem-session   { background: #1e3a5f; color: #60a5fa; }
  .mem-long_term { background: #2d1f3d; color: #c084fc; }

  /* Tools */
  .tools-on  { background: rgba(245, 158, 11, 0.18); color: var(--amber); }
  .tools-off { background: #1e293b; color: #475569; }

  /* Suggested model */
  .sm-local_fast       { background: #14291f; color: var(--green); }
  .sm-local_slow       { background: #2d2900; color: #a3a300; }
  .sm-billed_mini      { background: #1e2d4f; color: var(--blue); }
  .sm-billed_frontier  { background: #2d1f3d; color: var(--purple); }

  /* Security */
  .sec-clean             { background: #14291f; color: var(--green); }
  .sec-suspicious        { background: #2d200a; color: var(--amber); }
  .sec-prompt_injection  { background: #2d0f0f; color: var(--red); font-weight: 600; }

  /* Route */
  .rt-local_fast       { background: #14291f; color: var(--green); }
  .rt-local_slow       { background: #2d2900; color: #a3a300; }
  .rt-billed_mini      { background: #1e2d4f; color: var(--blue); }
  .rt-billed_frontier  { background: #2d1f3d; color: var(--purple); }
  .rt-reject           { background: #2d0f0f; color: var(--red); font-weight: 600; }
  .rt-fallback         { background: #2d1f1f; color: var(--red); }

  .dim-with-conf {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
  }

  .conf-num {
    font-size: 9px;
    color: var(--muted);
  }

  .conf-num.low { color: var(--red); }
  .conf-num.mid { color: var(--amber); }

  .agg-conf {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 10px;
  }
  .agg-conf .label { color: var(--muted); font-size: 9px; }
  .agg-conf .val { font-weight: 500; }
  .agg-conf .val.low { color: var(--red); }
  .agg-conf .val.mid { color: var(--amber); }
  .agg-conf .val.high { color: var(--green); }

  .escalated {
    font-size: 9px;
    color: var(--amber);
    margin-top: 2px;
  }

  .latency { color: var(--muted); font-size: 11px; }
  .latency.slow { color: var(--amber); }
  .latency.very-slow { color: var(--red); }

  .time { color: var(--muted); font-size: 10px; white-space: nowrap; }

  .fallback-badge { font-size: 10px; color: var(--red); margin-left: 4px; }

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
  <div id="empty">No traces yet — submit a request above or POST to /classify</div>
  <table id="table" style="display:none">
    <thead>
      <tr>
        <th style="width:7%">Time</th>
        <th class="input-cell">Input</th>
        <th>Task</th>
        <th>Memory</th>
        <th>Tools</th>
        <th>Model</th>
        <th>Security</th>
        <th>Conf</th>
        <th>Route</th>
        <th>ms</th>
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

  function confClass(c) {
    if (c < 0.5) return 'low';
    if (c < 0.7) return 'mid';
    return 'high';
  }

  function dimWithConf(value, conf, pillClass) {
    const cc = confClass(conf);
    return \`<div class="dim-with-conf">
      <span class="pill \${pillClass}">\${value.toString().replace(/_/g,' ')}</span>
      <span class="conf-num \${cc}">\${Math.round(conf * 100)}%</span>
    </div>\`;
  }

  function aggConf(c) {
    return \`<div class="agg-conf">
      <span><span class="label">avg </span><span class="val \${confClass(c.average_confidence)}">\${Math.round(c.average_confidence * 100)}%</span></span>
      <span><span class="label">min </span><span class="val \${confClass(c.min_confidence)}">\${Math.round(c.min_confidence * 100)}%</span></span>
    </div>\`;
  }

  function latencyCell(ms) {
    const cls = ms > 15000 ? 'very-slow' : ms > 8000 ? 'slow' : '';
    return \`<span class="latency \${cls}">\${ms}</span>\`;
  }

  function addRow(trace, animate) {
    const c = trace.classifier_output;
    const r = trace.route_decision;
    const isFallback = trace.fallback_used;
    const inputText = trace._user_input || '(redacted)';

    const row = document.createElement('tr');
    if (animate) row.classList.add('new-row');

    let escalation = '';
    if (r.escalated && r.escalation_reason) {
      escalation = \`<div class="escalated">↑ \${r.escalation_reason.replace(/_/g,' ')}</div>\`;
    }

    if (!c) {
      row.innerHTML = \`
        <td class="time">\${fmtTime(trace.timestamp)}</td>
        <td class="input-cell"><div class="input-text" title="\${inputText.replace(/"/g,'&quot;')}">\${inputText}</div></td>
        <td colspan="6" style="color:var(--red);font-size:11px">classifier_failed</td>
        <td><span class="pill rt-\${r.route}">\${r.route.replace(/_/g,' ')}</span>\${escalation}</td>
        <td>\${latencyCell(trace.classifier_latency_ms)}</td>
      \`;
    } else {
      row.innerHTML = \`
        <td class="time">\${fmtTime(trace.timestamp)}</td>
        <td class="input-cell"><div class="input-text" title="\${inputText.replace(/"/g,'&quot;')}">\${inputText}</div></td>
        <td>\${dimWithConf(c.task_class, c.confidences.task_class, 'tc-' + c.task_class)}</td>
        <td>\${dimWithConf(c.needs_memory, c.confidences.needs_memory, 'mem-' + c.needs_memory)}</td>
        <td>\${dimWithConf(c.tools_required ? 'yes' : 'no', c.confidences.tools_required, c.tools_required ? 'tools-on' : 'tools-off')}</td>
        <td>\${dimWithConf(c.suggested_model, c.confidences.suggested_model, 'sm-' + c.suggested_model)}</td>
        <td>\${dimWithConf(c.security, c.confidences.security, 'sec-' + c.security)}</td>
        <td>\${aggConf(c)}</td>
        <td><span class="pill rt-\${r.route}">\${r.route.replace(/_/g,' ')}</span>\${escalation}\${isFallback ? '<span class="fallback-badge">↯</span>' : ''}</td>
        <td>\${latencyCell(trace.classifier_latency_ms)}</td>
      \`;
    }

    tbody.prepend(row);
    traceCount++;
    countEl.textContent = traceCount + ' trace' + (traceCount === 1 ? '' : 's');
    empty.style.display = 'none';
    table.style.display = '';
  }

  function connect() {
    const es = new EventSource('/stream');

    es.onopen = () => {
      statusDot.className = 'connected';
      statusText.textContent = 'live';
    };

    es.onmessage = (e) => {
      const trace = JSON.parse(e.data);
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
