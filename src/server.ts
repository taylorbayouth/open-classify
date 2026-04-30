#!/usr/bin/env tsx
import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { loadConfig } from "./config.js";
import { classify, type SubEvent } from "./classify.js";
import { computeRoute } from "./route.js";
import { buildTrace } from "./trace.js";
import { InputEnvelopeSchema, type Trace } from "./schema.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_TRACES = 500;

const config = loadConfig();
type AugmentedTrace = Trace & { _user_input: string };

const traces: AugmentedTrace[] = [];

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

async function handleClassifyStream(
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

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Transfer-Encoding": "chunked",
  });

  // Send a "started" event with the request ID
  res.write(
    JSON.stringify({ type: "started", request_id: envelope.request_id, classifier_model: config.classifier.model }) +
      "\n"
  );

  const onEvent = (event: SubEvent): void => {
    res.write(JSON.stringify(event) + "\n");
  };

  const result = await classify(envelope, config.classifier, onEvent);
  const routeDecision = computeRoute(result.classification, config);

  // Final aggregate event
  res.write(
    JSON.stringify({
      type: "complete",
      classification: result.classification,
      route_decision: routeDecision,
      total_latency_ms: result.latency_ms,
      sub_latencies: result.sub_latencies,
      fallback_used: result.fallback_used,
    }) + "\n"
  );

  // Persist trace for /traces
  const trace: AugmentedTrace = {
    ...buildTrace({
      request_id: envelope.request_id,
      user_input: envelope.user_input,
      classifier_model: config.classifier.model,
      classifier_latency_ms: result.latency_ms,
      sub_latencies: result.classification ? result.sub_latencies : null,
      classifier_output: result.classification,
      validation_status: result.validation_status,
      route_decision: routeDecision,
      fallback_used: result.fallback_used,
    }),
    _user_input: envelope.user_input,
  };
  traces.unshift(trace);
  if (traces.length > MAX_TRACES) traces.pop();

  res.end();
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
    await handleClassifyStream(req, res);
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
    `Note: 5 parallel sub-classifier calls per classification. For Ollama, use OLLAMA_NUM_PARALLEL=5.`
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
    --bg: #0d0f15;
    --surface: #161923;
    --surface-2: #1f2330;
    --border: #2a2f3e;
    --border-strong: #3a4055;
    --text: #f1f5f9;
    --text-2: #cbd5e1;
    --muted: #64748b;
    --muted-2: #475569;
    --green: #22c55e;
    --green-bg: #052e16;
    --amber: #f59e0b;
    --amber-bg: #2d1f00;
    --red: #ef4444;
    --red-bg: #3b0d0d;
    --blue: #3b82f6;
    --blue-bg: #0c1e3a;
    --purple: #a855f7;
    --purple-bg: #2a0e3a;
    --teal: #14b8a6;
    --teal-bg: #062c28;
    --yellow: #eab308;
    --yellow-bg: #2d2400;
    --font: 'SF Mono', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.5;
    height: 100vh;
    overflow: hidden;
  }

  header {
    padding: 14px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 16px;
    background: var(--bg);
  }

  header h1 {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text);
  }

  header .model { color: var(--muted); font-size: 11px; }
  header .status { margin-left: auto; font-size: 11px; color: var(--muted); }

  .main {
    display: grid;
    grid-template-columns: minmax(360px, 1fr) minmax(560px, 1.5fr);
    height: calc(100vh - 53px);
  }

  /* ─── Left: input ─── */

  .input-pane {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    padding: 24px;
    gap: 12px;
    background: var(--bg);
  }

  .input-pane label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted);
    font-weight: 600;
  }

  textarea {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    color: var(--text);
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.7;
    resize: none;
    outline: none;
    transition: border-color 0.15s;
  }

  textarea:focus { border-color: var(--blue); }
  textarea::placeholder { color: var(--muted-2); }

  .input-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  button.primary {
    background: var(--blue);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 10px 22px;
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.03em;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  button.primary:hover:not(:disabled) { opacity: 0.85; }
  button.primary:disabled { opacity: 0.4; cursor: default; }

  .hint { color: var(--muted); font-size: 11px; }
  .char-count { margin-left: auto; color: var(--muted); font-size: 11px; }

  /* ─── Right: results ─── */

  .results-pane {
    padding: 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .results-pane > .empty {
    color: var(--muted);
    font-size: 12px;
    margin-top: 60px;
    text-align: center;
  }

  /* ─── Dimension card ─── */

  .dim-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
    transition: border-color 0.2s, opacity 0.2s;
  }

  .dim-card.pending { opacity: 0.55; }
  .dim-card.done { border-color: var(--border-strong); }
  .dim-card.failed { border-color: var(--red); }

  .dim-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .dim-name {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-2);
  }

  .dim-meta {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--muted);
  }

  .dim-meta .latency { font-variant-numeric: tabular-nums; }

  .dim-options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 12px;
  }

  .opt {
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: 5px;
    font-size: 12px;
    color: var(--muted-2);
    background: transparent;
    transition: all 0.15s;
    white-space: nowrap;
    font-weight: 500;
  }

  /* Selected option — strongly highlighted, with per-dim color theme */
  .opt.selected {
    color: var(--text);
    font-weight: 600;
    border-width: 1px;
  }

  /* task_class colors */
  .opt.selected[data-dim="task_class"][data-val="chat"]     { background: #334155; border-color: #94a3b8; color: #f1f5f9; }
  .opt.selected[data-dim="task_class"][data-val="draft"]    { background: #1d4ed8; border-color: #60a5fa; color: #ffffff; }
  .opt.selected[data-dim="task_class"][data-val="code"]     { background: #166534; border-color: #4ade80; color: #ffffff; }
  .opt.selected[data-dim="task_class"][data-val="research"] { background: #7c3aed; border-color: #c084fc; color: #ffffff; }
  .opt.selected[data-dim="task_class"][data-val="unknown"]  { background: #b91c1c; border-color: #f87171; color: #ffffff; }

  /* needs_memory colors */
  .opt.selected[data-dim="needs_memory"][data-val="none"]      { background: #334155; border-color: #94a3b8; color: #f1f5f9; }
  .opt.selected[data-dim="needs_memory"][data-val="recent"]    { background: #0f766e; border-color: #2dd4bf; color: #ffffff; }
  .opt.selected[data-dim="needs_memory"][data-val="session"]   { background: #1d4ed8; border-color: #60a5fa; color: #ffffff; }
  .opt.selected[data-dim="needs_memory"][data-val="long_term"] { background: #7c3aed; border-color: #c084fc; color: #ffffff; }

  /* tools_required colors */
  .opt.selected[data-dim="tools_required"][data-val="true"]  { background: #b45309; border-color: #fbbf24; color: #ffffff; }
  .opt.selected[data-dim="tools_required"][data-val="false"] { background: #334155; border-color: #94a3b8; color: #f1f5f9; }

  /* suggested_model colors */
  .opt.selected[data-dim="suggested_model"][data-val="local_fast"]      { background: #166534; border-color: #4ade80; color: #ffffff; }
  .opt.selected[data-dim="suggested_model"][data-val="local_slow"]      { background: #854d0e; border-color: #facc15; color: #ffffff; }
  .opt.selected[data-dim="suggested_model"][data-val="billed_mini"]     { background: #1d4ed8; border-color: #60a5fa; color: #ffffff; }
  .opt.selected[data-dim="suggested_model"][data-val="billed_frontier"] { background: #7c3aed; border-color: #c084fc; color: #ffffff; }

  /* security colors */
  .opt.selected[data-dim="security"][data-val="clean"]            { background: #166534; border-color: #4ade80; color: #ffffff; }
  .opt.selected[data-dim="security"][data-val="suspicious"]       { background: #b45309; border-color: #fbbf24; color: #ffffff; }
  .opt.selected[data-dim="security"][data-val="prompt_injection"] { background: #b91c1c; border-color: #f87171; color: #ffffff; font-weight: 700; }

  /* Confidence bar */
  .conf-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .conf-label {
    font-size: 10px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    min-width: 78px;
  }

  .conf-track {
    flex: 1;
    height: 6px;
    background: var(--surface-2);
    border-radius: 3px;
    overflow: hidden;
  }

  .conf-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.3s ease, background-color 0.3s;
    width: 0;
  }

  .conf-num {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    min-width: 38px;
    text-align: right;
  }

  .conf-num.low  { color: var(--red); }
  .conf-num.mid  { color: var(--amber); }
  .conf-num.high { color: var(--green); }

  .pending-state {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 12px;
    font-style: italic;
  }

  .spinner {
    display: inline-block;
    width: 11px;
    height: 11px;
    border: 1.5px solid var(--border);
    border-top-color: var(--blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .failed-state {
    color: var(--red);
    font-size: 12px;
    font-weight: 500;
  }

  .debug-row {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px dashed var(--border);
    display: flex;
    gap: 8px;
  }

  .debug-toggle {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: var(--font);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .debug-toggle:hover { color: var(--text-2); border-color: var(--border-strong); }
  .debug-toggle.active { color: var(--blue); border-color: var(--blue); }

  .debug-content {
    margin-top: 10px;
    padding: 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 11px;
    line-height: 1.55;
    color: var(--text-2);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 360px;
    overflow-y: auto;
    display: none;
  }

  .debug-content.show { display: block; }
  .debug-content .label {
    color: var(--muted);
    text-transform: uppercase;
    font-size: 9px;
    letter-spacing: 0.1em;
    font-weight: 600;
    margin-bottom: 6px;
  }

  /* ─── Aggregate / route ─── */

  .aggregate {
    margin-top: 12px;
    background: var(--surface);
    border: 2px solid var(--border-strong);
    border-radius: 10px;
    padding: 18px 20px;
  }

  .aggregate.escalated { border-color: var(--amber); }
  .aggregate.rejected  { border-color: var(--red); }
  .aggregate.fallback  { border-color: var(--red); }

  .agg-header {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-2);
    margin-bottom: 14px;
  }

  .agg-stats {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 18px;
    margin-bottom: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }

  .agg-stat .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 4px;
  }

  .agg-stat .value {
    font-size: 22px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text);
    line-height: 1.1;
  }

  .agg-stat .value.low  { color: var(--red); }
  .agg-stat .value.mid  { color: var(--amber); }
  .agg-stat .value.high { color: var(--green); }

  .agg-stat .sub {
    font-size: 10px;
    color: var(--muted);
    margin-top: 2px;
  }

  .route-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .route-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .route-pill {
    display: inline-block;
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.02em;
    border: 1px solid;
  }

  .route-pill[data-route="local_fast"]       { background: #166534; border-color: #4ade80; color: #ffffff; }
  .route-pill[data-route="local_slow"]       { background: #854d0e; border-color: #facc15; color: #ffffff; }
  .route-pill[data-route="billed_mini"]      { background: #1d4ed8; border-color: #60a5fa; color: #ffffff; }
  .route-pill[data-route="billed_frontier"]  { background: #7c3aed; border-color: #c084fc; color: #ffffff; }
  .route-pill[data-route="reject"]           { background: #b91c1c; border-color: #f87171; color: #ffffff; }
  .route-pill[data-route="fallback"]         { background: #4b1818; border-color: #f87171; color: #ffffff; }

  .escalation-note {
    font-size: 12px;
    color: var(--amber);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .flags-row {
    display: flex;
    gap: 8px;
    margin-top: 4px;
    flex-wrap: wrap;
  }

  .flag {
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--border);
  }

  .flag.on {
    background: var(--amber-bg);
    color: var(--amber);
    border-color: var(--amber);
  }

  .flag.confirm {
    background: var(--red-bg);
    color: var(--red);
    border-color: var(--red);
    font-weight: 600;
  }
</style>
</head>
<body>

<header>
  <h1>LLM Harness</h1>
  <span class="model" id="model-name">—</span>
  <span class="status" id="status">ready</span>
</header>

<div class="main">

  <div class="input-pane">
    <label for="prompt">Request</label>
    <textarea id="prompt" placeholder="Enter a request to classify…&#10;&#10;Press Cmd/Ctrl+Enter to submit." autofocus></textarea>
    <div class="input-actions">
      <button class="primary" id="submit-btn" onclick="submitClassify()">Classify</button>
      <span class="hint">Cmd/Ctrl+Enter</span>
      <span class="char-count" id="char-count">0 chars</span>
    </div>
  </div>

  <div class="results-pane" id="results">
    <div class="empty">Submit a request to see the live classification.</div>
  </div>

</div>

<script>
  const DIMENSIONS = [
    { key: 'task_class',      label: 'task class',      options: ['chat', 'draft', 'code', 'research'] },
    { key: 'needs_memory',    label: 'needs memory',    options: ['none', 'recent', 'session', 'long_term'] },
    { key: 'tools_required',  label: 'tools required',  options: ['true', 'false'] },
    { key: 'suggested_model', label: 'suggested model', options: ['local_fast', 'local_slow', 'billed_mini', 'billed_frontier'] },
    { key: 'security',        label: 'security',        options: ['clean', 'suspicious', 'prompt_injection'] },
  ];

  const prompt = document.getElementById('prompt');
  const submitBtn = document.getElementById('submit-btn');
  const charCount = document.getElementById('char-count');
  const results = document.getElementById('results');
  const statusEl = document.getElementById('status');
  const modelName = document.getElementById('model-name');

  prompt.addEventListener('input', () => {
    charCount.textContent = prompt.value.length + ' chars';
  });

  prompt.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submitClassify();
    }
  });

  function confClass(c) {
    if (c < 0.5) return 'low';
    if (c < 0.7) return 'mid';
    return 'high';
  }

  function confColor(c) {
    if (c < 0.5) return 'var(--red)';
    if (c < 0.7) return 'var(--amber)';
    return 'var(--green)';
  }

  function buildSkeleton() {
    results.innerHTML = '';
    DIMENSIONS.forEach(({ key, label, options }) => {
      const card = document.createElement('div');
      card.className = 'dim-card pending';
      card.id = 'card-' + key;

      const optsHtml = options.map(opt => \`
        <div class="opt" data-dim="\${key}" data-val="\${opt}">\${opt.replace(/_/g, ' ')}</div>
      \`).join('');

      card.innerHTML = \`
        <div class="dim-header">
          <div class="dim-name">\${label}</div>
          <div class="dim-meta">
            <span class="latency">—</span>
          </div>
        </div>
        <div class="dim-options">\${optsHtml}</div>
        <div class="conf-row">
          <span class="conf-label">confidence</span>
          <div class="conf-track"><div class="conf-fill"></div></div>
          <span class="conf-num">—</span>
        </div>
        <div class="pending-state" style="margin-top:8px"><span class="spinner"></span> waiting for classifier…</div>
        <div class="debug-row" style="display:none">
          <button class="debug-toggle" data-target="raw">raw output</button>
          <button class="debug-toggle" data-target="prompt">prompt</button>
        </div>
        <div class="debug-content" data-kind="raw"></div>
        <div class="debug-content" data-kind="prompt"></div>
      \`;
      results.appendChild(card);
    });

    const agg = document.createElement('div');
    agg.className = 'aggregate';
    agg.id = 'aggregate';
    agg.style.display = 'none';
    results.appendChild(agg);
  }

  function updateCard(dim, data, latency_ms, raw_output, prompt) {
    const card = document.getElementById('card-' + dim);
    if (!card) return;
    card.classList.remove('pending');

    const latEl = card.querySelector('.latency');
    const fillEl = card.querySelector('.conf-fill');
    const numEl = card.querySelector('.conf-num');
    const pendingEl = card.querySelector('.pending-state');

    if (pendingEl) pendingEl.remove();
    latEl.textContent = latency_ms + 'ms';

    // Populate debug panels
    const debugRow = card.querySelector('.debug-row');
    const rawPanel = card.querySelector('.debug-content[data-kind="raw"]');
    const promptPanel = card.querySelector('.debug-content[data-kind="prompt"]');
    if (debugRow) debugRow.style.display = '';
    if (rawPanel) rawPanel.innerHTML = '<div class="label">model raw output</div>' + escapeHtml(raw_output || '(empty)');
    if (promptPanel) promptPanel.innerHTML = '<div class="label">system prompt</div>' + escapeHtml(prompt || '');

    // Wire toggles
    card.querySelectorAll('.debug-toggle').forEach(btn => {
      btn.onclick = () => {
        const target = btn.getAttribute('data-target');
        const panel = card.querySelector('.debug-content[data-kind="' + target + '"]');
        const isOpen = panel.classList.contains('show');
        // close all panels and toggles in this card first
        card.querySelectorAll('.debug-content').forEach(p => p.classList.remove('show'));
        card.querySelectorAll('.debug-toggle').forEach(b => b.classList.remove('active'));
        if (!isOpen) {
          panel.classList.add('show');
          btn.classList.add('active');
        }
      };
    });

    if (!data) {
      card.classList.add('failed');
      const fail = document.createElement('div');
      fail.className = 'failed-state';
      fail.textContent = '✕ classifier failed';
      fail.style.marginTop = '8px';
      // insert before debug-row so debug stays at the bottom
      card.insertBefore(fail, debugRow);
      numEl.textContent = '—';
      return;
    }

    card.classList.add('done');

    // Highlight selected option
    const valStr = String(data.value);
    card.querySelectorAll('.opt').forEach(opt => {
      if (opt.getAttribute('data-val') === valStr) {
        opt.classList.add('selected');
      }
    });

    // Confidence bar + number
    const pct = Math.round(data.confidence * 100);
    fillEl.style.width = pct + '%';
    fillEl.style.background = confColor(data.confidence);
    numEl.textContent = pct + '%';
    numEl.className = 'conf-num ' + confClass(data.confidence);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  }

  function renderAggregate(complete) {
    const agg = document.getElementById('aggregate');
    if (!agg) return;
    agg.style.display = '';
    agg.className = 'aggregate';

    const c = complete.classification;
    const r = complete.route_decision;

    if (!c) {
      agg.classList.add('fallback');
      agg.innerHTML = \`
        <div class="agg-header">Classification result</div>
        <div style="color:var(--red);font-size:13px;margin-bottom:14px">
          ✕ Classification failed — using fallback route
        </div>
        <div class="route-section">
          <div class="route-label">Final route</div>
          <div><span class="route-pill" data-route="\${r.route}">\${r.route.replace(/_/g, ' ')}</span></div>
        </div>
      \`;
      return;
    }

    if (r.route === 'reject') agg.classList.add('rejected');
    else if (r.escalated) agg.classList.add('escalated');

    const avgPct = Math.round(c.average_confidence * 100);
    const minPct = Math.round(c.min_confidence * 100);

    let escalation = '';
    if (r.escalated && r.escalation_reason) {
      escalation = \`<div class="escalation-note">⚠ Escalated to frontier — reason: \${r.escalation_reason.replace(/_/g, ' ')}</div>\`;
    }

    const flags = [];
    flags.push(\`<span class="flag \${r.tools_required ? 'on' : ''}">tools: \${r.tools_required ? 'yes' : 'no'}</span>\`);
    flags.push(\`<span class="flag">memory: \${r.memory_scope.replace(/_/g, ' ')}</span>\`);
    if (r.requires_confirmation) {
      flags.push(\`<span class="flag confirm">⚠ requires user confirmation</span>\`);
    }

    agg.innerHTML = \`
      <div class="agg-header">Aggregate confidence</div>
      <div class="agg-stats">
        <div class="agg-stat">
          <div class="label">average</div>
          <div class="value \${confClass(c.average_confidence)}">\${avgPct}%</div>
          <div class="sub">across all 5 classifiers</div>
        </div>
        <div class="agg-stat">
          <div class="label">minimum</div>
          <div class="value \${confClass(c.min_confidence)}">\${minPct}%</div>
          <div class="sub">lowest single classifier</div>
        </div>
        <div class="agg-stat">
          <div class="label">total latency</div>
          <div class="value">\${complete.total_latency_ms}<span style="font-size:14px;color:var(--muted)">ms</span></div>
          <div class="sub">wall-clock time</div>
        </div>
      </div>
      <div class="route-section">
        <div class="route-label">Final route</div>
        <div><span class="route-pill" data-route="\${r.route}">\${r.route.replace(/_/g, ' ')}</span></div>
        \${escalation}
        <div class="flags-row">\${flags.join('')}</div>
      </div>
    \`;
  }

  async function submitClassify() {
    const val = prompt.value.trim();
    if (!val) return;

    submitBtn.disabled = true;
    statusEl.textContent = 'classifying…';
    buildSkeleton();

    try {
      const response = await fetch('/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_input: val }),
      });

      if (!response.ok) {
        statusEl.textContent = 'error: ' + response.status;
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nl;
        while ((nl = buffer.indexOf('\\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;

          let event;
          try { event = JSON.parse(line); } catch { continue; }

          if (event.type === 'started') {
            modelName.textContent = event.classifier_model;
          } else if (event.type === 'sub_result') {
            updateCard(event.dimension, event.data, event.latency_ms, event.raw_output, event.prompt);
          } else if (event.type === 'complete') {
            renderAggregate(event);
          }
        }
      }

      statusEl.textContent = 'done';
    } catch(e) {
      console.error(e);
      statusEl.textContent = 'error';
    } finally {
      submitBtn.disabled = false;
    }
  }
</script>
</body>
</html>`;
