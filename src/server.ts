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
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface-2: #252836;
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
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  header .model {
    color: var(--muted);
    font-size: 11px;
  }

  header .status {
    margin-left: auto;
    font-size: 11px;
    color: var(--muted);
  }

  .main {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    height: calc(100vh - 53px);
  }

  /* ─── Left: input ─── */

  .input-pane {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    padding: 24px;
    gap: 12px;
  }

  .input-pane label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  textarea {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px;
    color: var(--text);
    font-family: var(--font);
    font-size: 13px;
    line-height: 1.6;
    resize: none;
    outline: none;
  }

  textarea:focus { border-color: var(--blue); }

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
    padding: 10px 20px;
    font-family: var(--font);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.15s;
  }

  button.primary:hover:not(:disabled) { opacity: 0.85; }
  button.primary:disabled { opacity: 0.4; cursor: default; }

  .hint {
    color: var(--muted);
    font-size: 11px;
  }

  .char-count {
    margin-left: auto;
    color: var(--muted);
    font-size: 11px;
  }

  /* ─── Right: results ─── */

  .results-pane {
    padding: 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .results-pane > .empty {
    color: var(--muted);
    font-size: 12px;
    margin-top: 40px;
    text-align: center;
  }

  .dim-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: 12px;
    transition: border-color 0.2s;
  }

  .dim-card.pending {
    opacity: 0.55;
  }

  .dim-card.done {
    border-color: var(--green);
  }

  .dim-card.failed {
    border-color: var(--red);
    opacity: 0.85;
  }

  .dim-card .dim-name {
    font-size: 10px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 4px;
  }

  .dim-card .dim-value {
    font-size: 14px;
    font-weight: 500;
  }

  .dim-card .dim-value .pending-text {
    color: var(--muted);
    font-style: italic;
    font-weight: 400;
  }

  .dim-card .dim-value .failed-text {
    color: var(--red);
    font-size: 12px;
  }

  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
  }

  /* per-dim coloring */
  .pill.tc-chat     { background: #1e293b; color: #94a3b8; }
  .pill.tc-draft    { background: #1e3a5f; color: #60a5fa; }
  .pill.tc-code     { background: #1a2e1a; color: #4ade80; }
  .pill.tc-research { background: #2d1f3d; color: #c084fc; }
  .pill.tc-unknown  { background: #2d1f1f; color: #f87171; }

  .pill.mem-none      { background: #1e293b; color: #64748b; }
  .pill.mem-recent    { background: #1f2d2d; color: #2dd4bf; }
  .pill.mem-session   { background: #1e3a5f; color: #60a5fa; }
  .pill.mem-long_term { background: #2d1f3d; color: #c084fc; }

  .pill.tools-on  { background: rgba(245, 158, 11, 0.18); color: var(--amber); }
  .pill.tools-off { background: #1e293b; color: #475569; }

  .pill.sm-local_fast       { background: #14291f; color: var(--green); }
  .pill.sm-local_slow       { background: #2d2900; color: #d4c000; }
  .pill.sm-billed_mini      { background: #1e2d4f; color: var(--blue); }
  .pill.sm-billed_frontier  { background: #2d1f3d; color: var(--purple); }

  .pill.sec-clean             { background: #14291f; color: var(--green); }
  .pill.sec-suspicious        { background: #2d200a; color: var(--amber); }
  .pill.sec-prompt_injection  { background: #2d0f0f; color: var(--red); font-weight: 600; }

  .pill.rt-local_fast       { background: #14291f; color: var(--green); }
  .pill.rt-local_slow       { background: #2d2900; color: #d4c000; }
  .pill.rt-billed_mini      { background: #1e2d4f; color: var(--blue); }
  .pill.rt-billed_frontier  { background: #2d1f3d; color: var(--purple); }
  .pill.rt-reject           { background: #2d0f0f; color: var(--red); font-weight: 600; }
  .pill.rt-fallback         { background: #2d1f1f; color: var(--red); }

  .conf-block {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    min-width: 56px;
  }

  .conf-track {
    width: 56px;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
  }

  .conf-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  .conf-num {
    font-size: 11px;
    color: var(--muted);
  }

  .latency-block {
    color: var(--muted);
    font-size: 11px;
    min-width: 48px;
    text-align: right;
  }

  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 1.5px solid var(--border);
    border-top-color: var(--blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ─── Aggregate / route ─── */

  .aggregate {
    margin-top: 8px;
    padding: 16px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .aggregate.escalated {
    border-color: var(--amber);
  }

  .aggregate.rejected {
    border-color: var(--red);
  }

  .aggregate.fallback {
    border-color: var(--red);
  }

  .aggregate .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .aggregate .conf-row {
    display: flex;
    gap: 24px;
    align-items: center;
  }

  .aggregate .conf-row .item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .aggregate .conf-row .label {
    margin: 0;
  }

  .aggregate .val { font-weight: 500; }
  .aggregate .val.low { color: var(--red); }
  .aggregate .val.mid { color: var(--amber); }
  .aggregate .val.high { color: var(--green); }

  .aggregate .route-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    font-size: 14px;
  }

  .aggregate .route-arrow {
    color: var(--muted);
  }

  .aggregate .escalation-note {
    font-size: 11px;
    color: var(--amber);
  }

  .aggregate .meta {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--muted);
  }

  .aggregate .meta .flag {
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--surface-2);
  }

  .aggregate .meta .flag.on { color: var(--amber); background: rgba(245, 158, 11, 0.1); }
</style>
</head>
<body>

<header>
  <h1>LLM Harness</h1>
  <span class="model" id="model-name">—</span>
  <span class="status" id="status">ready</span>
</header>

<div class="main">

  <!-- ─── Left: input ─── -->
  <div class="input-pane">
    <label for="prompt">Request</label>
    <textarea id="prompt" placeholder="Enter a request to classify…&#10;&#10;Cmd/Ctrl+Enter to submit." autofocus></textarea>
    <div class="input-actions">
      <button class="primary" id="submit-btn" onclick="submitClassify()">Classify</button>
      <span class="hint">Cmd/Ctrl+Enter</span>
      <span class="char-count" id="char-count">0 chars</span>
    </div>
  </div>

  <!-- ─── Right: live results ─── -->
  <div class="results-pane" id="results">
    <div class="empty">Submit a request to see the live classification.</div>
  </div>

</div>

<script>
  const DIMENSIONS = [
    'task_class',
    'needs_memory',
    'tools_required',
    'suggested_model',
    'security',
  ];

  const PILL_PREFIX = {
    task_class: 'tc-',
    needs_memory: 'mem-',
    tools_required: '',
    suggested_model: 'sm-',
    security: 'sec-',
  };

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

  function pillClass(dim, value) {
    if (dim === 'tools_required') {
      return value ? 'tools-on' : 'tools-off';
    }
    return PILL_PREFIX[dim] + value;
  }

  function pillLabel(dim, value) {
    if (dim === 'tools_required') return value ? 'yes' : 'no';
    return String(value).replace(/_/g, ' ');
  }

  function buildSkeleton() {
    results.innerHTML = '';
    DIMENSIONS.forEach(dim => {
      const card = document.createElement('div');
      card.className = 'dim-card pending';
      card.id = 'card-' + dim;
      card.innerHTML = \`
        <div>
          <div class="dim-name">\${dim.replace(/_/g, ' ')}</div>
          <div class="dim-value"><span class="pending-text"><span class="spinner"></span> waiting…</span></div>
        </div>
        <div class="conf-block">
          <div class="conf-track"><div class="conf-fill" style="width:0"></div></div>
          <div class="conf-num">—</div>
        </div>
        <div class="latency-block">—</div>
      \`;
      results.appendChild(card);
    });
    // aggregate placeholder
    const agg = document.createElement('div');
    agg.className = 'aggregate';
    agg.id = 'aggregate';
    agg.style.display = 'none';
    results.appendChild(agg);
  }

  function updateCard(dim, data, latency_ms) {
    const card = document.getElementById('card-' + dim);
    if (!card) return;
    card.classList.remove('pending');

    const valueEl = card.querySelector('.dim-value');
    const fillEl = card.querySelector('.conf-fill');
    const numEl = card.querySelector('.conf-num');
    const latEl = card.querySelector('.latency-block');

    if (!data) {
      card.classList.add('failed');
      valueEl.innerHTML = '<span class="failed-text">classifier failed</span>';
      numEl.textContent = '—';
      latEl.textContent = latency_ms + 'ms';
      return;
    }

    card.classList.add('done');
    const cls = pillClass(dim, data.value);
    const lbl = pillLabel(dim, data.value);
    valueEl.innerHTML = \`<span class="pill \${cls}">\${lbl}</span>\`;

    const pct = Math.round(data.confidence * 100);
    fillEl.style.width = pct + '%';
    fillEl.style.background = confColor(data.confidence);
    numEl.textContent = pct + '%';
    numEl.style.color = confColor(data.confidence);
    latEl.textContent = latency_ms + 'ms';
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
        <div class="label">Result</div>
        <div style="color:var(--red);font-size:13px">Classification failed — using fallback route</div>
        <div class="route-row">
          <span class="route-arrow">→</span>
          <span class="pill rt-\${r.route}">\${r.route.replace(/_/g, ' ')}</span>
        </div>
      \`;
      return;
    }

    if (r.route === 'reject') agg.classList.add('rejected');
    else if (r.escalated) agg.classList.add('escalated');

    const avgPct = Math.round(c.average_confidence * 100);
    const minPct = Math.round(c.min_confidence * 100);

    let escalationNote = '';
    if (r.escalated && r.escalation_reason) {
      escalationNote = \`<div class="escalation-note">↑ escalated: \${r.escalation_reason.replace(/_/g, ' ')}</div>\`;
    }

    agg.innerHTML = \`
      <div class="label">Aggregate</div>
      <div class="conf-row">
        <div class="item"><span class="label">avg</span><span class="val \${confClass(c.average_confidence)}">\${avgPct}%</span></div>
        <div class="item"><span class="label">min</span><span class="val \${confClass(c.min_confidence)}">\${minPct}%</span></div>
        <div class="item"><span class="label">total</span><span class="val">\${complete.total_latency_ms}ms</span></div>
      </div>
      <div class="route-row">
        <span class="route-arrow">→</span>
        <span class="pill rt-\${r.route}">\${r.route.replace(/_/g, ' ')}</span>
        \${r.requires_confirmation ? '<span class="meta"><span class="flag on">requires confirmation</span></span>' : ''}
      </div>
      \${escalationNote}
      <div class="meta">
        <span class="flag \${r.tools_required ? 'on' : ''}">tools: \${r.tools_required ? 'yes' : 'no'}</span>
        <span class="flag">memory: \${r.memory_scope.replace(/_/g, ' ')}</span>
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
            updateCard(event.dimension, event.data, event.latency_ms);
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
