#!/usr/bin/env tsx
import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { loadConfig, classifierModelSummary } from "./config.js";
import { classify } from "./classify.js";
import { buildTrace } from "./trace.js";
import { InputEnvelopeSchema, type Trace } from "./schema.js";
import { CLASSIFIERS, DIMENSION_KEYS } from "./classifiers.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_TRACES = 500;

const config = loadConfig();
const MAX_BODY_BYTES = config.server.max_body_bytes;

const traces: Trace[] = [];

class PayloadTooLargeError extends Error {
  constructor() {
    super("payload too large");
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      if (size > maxBytes) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      body += chunk;
    });
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
  // Reject up front when the client tells us the body is over-limit.
  const declaredLen = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    json(res, 413, { error: "Payload too large", code: "payload_too_large" });
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      json(res, 413, { error: "Payload too large", code: "payload_too_large" });
    } else {
      json(res, 400, { error: "Failed to read request body", code: "bad_request" });
    }
    return;
  }

  let body: { user_input?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    json(res, 400, { error: "Invalid JSON body", code: "invalid_json" });
    return;
  }

  const parsed = InputEnvelopeSchema.safeParse({
    request_id: randomUUID(),
    user_input: body.user_input,
  });
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "invalid user_input";
    json(res, 400, { error: msg, code: "invalid_input" });
    return;
  }
  const envelope = parsed.data;

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Transfer-Encoding": "chunked",
  });

  // Both maps are derived from the registry — adding/removing a classifier
  // updates them automatically with no other server-side change.
  const classifier_models = Object.fromEntries(
    DIMENSION_KEYS.map((d) => [d, config.classifiers[d].model])
  );
  const classifier_options = Object.fromEntries(
    DIMENSION_KEYS.flatMap((d) => {
      const opts = CLASSIFIERS[d].displayOptions;
      return opts ? [[d, opts]] : [];
    })
  );

  res.write(
    JSON.stringify({
      type: "started",
      request_id: envelope.request_id,
      classifier_models,
      classifier_options,
      thresholds: {
        avg_confidence: config.routing.avg_confidence_threshold,
        min_confidence: config.routing.min_confidence_threshold,
      },
    }) + "\n"
  );

  const result = await classify(envelope, config.classifiers, (event) => {
    res.write(JSON.stringify(event) + "\n");
  });

  res.write(
    JSON.stringify({
      type: "complete",
      total_latency_ms: result.total_latency_ms,
    }) + "\n"
  );

  const trace = buildTrace({
    request_id: envelope.request_id,
    user_input: envelope.user_input,
    total_latency_ms: result.total_latency_ms,
    sub_results: result.sub_results,
  });
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
  console.log(`Classifier models: ${classifierModelSummary(config.classifiers)}`);
  console.log(
    `Note: ${DIMENSION_KEYS.length} parallel sub-classifier calls per classification. For Ollama, use OLLAMA_NUM_PARALLEL=${DIMENSION_KEYS.length}.`
  );
});

// ─── Frontend ───────────────────────────────────────────────────────────────

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>open-classify</title>
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
    --amber: #f59e0b;
    --amber-bg: #2d1f00;
    --red: #ef4444;
    --red-bg: #3b0d0d;
    --blue: #3b82f6;
    --blue-bg: #0c1e3a;
    --purple: #a855f7;
    --teal: #14b8a6;
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
  }

  header .sub { color: var(--muted); font-size: 11px; }
  header .status { margin-left: auto; font-size: 11px; color: var(--muted); }

  .main {
    display: grid;
    grid-template-columns: minmax(360px, 1fr) minmax(680px, 1.7fr);
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
    gap: 16px;
  }

  .results-pane > .empty {
    color: var(--muted);
    font-size: 12px;
    margin-top: 60px;
    text-align: center;
  }

  /* ─── Awk hero ─── */

  .awk-hero {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px 22px;
    transition: border-color 0.2s, opacity 0.2s;
  }
  .awk-hero.pending { opacity: 0.55; }
  .awk-hero.done    { border-color: var(--border-strong); }
  .awk-hero.failed  { border-color: var(--red); }
  .awk-hero.overridden { border-color: var(--amber); }

  .awk-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 12px;
    gap: 12px;
  }

  .awk-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
  }

  .awk-meta {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--muted);
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .awk-meta .latency { font-variant-numeric: tabular-nums; }
  .awk-meta .model-name { color: var(--muted-2); font-size: 10px; }

  .awk-text {
    font-size: 22px;
    font-weight: 500;
    line-height: 1.35;
    color: var(--text);
    margin-bottom: 14px;
    word-break: break-word;
  }
  .awk-text.placeholder { color: var(--muted); font-style: italic; font-size: 14px; }
  .awk-text.overridden { color: var(--amber); font-style: italic; }

  .awk-badges {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  .mode-pill {
    padding: 5px 12px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border: 1px solid;
  }
  .mode-pill[data-mode="only"]     { background: #166534; border-color: #4ade80; color: #fff; }
  .mode-pill[data-mode="first"]    { background: #1d4ed8; border-color: #60a5fa; color: #fff; }
  .mode-pill[data-mode="question"] { background: #b45309; border-color: #fbbf24; color: #fff; }

  .send-badge {
    padding: 5px 10px;
    border-radius: 5px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .send-badge.on  { background: var(--blue-bg); color: var(--blue); border-color: var(--blue); }
  .send-badge.off { background: var(--red-bg); color: var(--red); border-color: var(--red); }

  .awk-conf-row {
    margin-top: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  /* ─── Card grid ─── */

  .card-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 14px;
  }

  .dim-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 16px;
    transition: border-color 0.2s, opacity 0.2s;
  }

  .dim-card.pending { opacity: 0.55; }
  .dim-card.done { border-color: var(--border-strong); }
  .dim-card.failed { border-color: var(--red); }
  .dim-card.overridden { border-color: var(--amber); }

  .dim-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 10px;
    gap: 12px;
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
    gap: 10px;
    font-size: 10px;
    color: var(--muted);
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .dim-meta .model-name { color: var(--muted-2); }
  .dim-meta .latency { font-variant-numeric: tabular-nums; }

  .dim-options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }

  .opt {
    padding: 4px 9px;
    border: 1px solid var(--border);
    border-radius: 5px;
    font-size: 11px;
    color: var(--muted-2);
    background: transparent;
    transition: all 0.15s;
    white-space: nowrap;
    font-weight: 500;
  }

  .opt.selected {
    color: var(--text);
    font-weight: 600;
  }

  /* response_path colors */
  .opt.selected[data-dim="response_path"][data-val="none"]          { background: #334155; border-color: #94a3b8; color: #f1f5f9; }
  .opt.selected[data-dim="response_path"][data-val="small_model"]   { background: #166534; border-color: #4ade80; color: #fff; }
  .opt.selected[data-dim="response_path"][data-val="large_model"]   { background: #7c3aed; border-color: #c084fc; color: #fff; }
  .opt.selected[data-dim="response_path"][data-val="tool_assisted"] { background: #1d4ed8; border-color: #60a5fa; color: #fff; }
  .opt.selected[data-dim="response_path"][data-val="workflow"]      { background: #b45309; border-color: #fbbf24; color: #fff; }

  /* context_budget colors */
  .opt.selected[data-dim="context_budget"][data-val="none"]                   { background: #334155; border-color: #94a3b8; color: #f1f5f9; }
  .opt.selected[data-dim="context_budget"][data-val="current_message_only"]   { background: #0f766e; border-color: #2dd4bf; color: #fff; }
  .opt.selected[data-dim="context_budget"][data-val="last_exchange"]          { background: #166534; border-color: #4ade80; color: #fff; }
  .opt.selected[data-dim="context_budget"][data-val="recent_context"]         { background: #1d4ed8; border-color: #60a5fa; color: #fff; }
  .opt.selected[data-dim="context_budget"][data-val="retrieved_context_only"] { background: #b45309; border-color: #fbbf24; color: #fff; }
  .opt.selected[data-dim="context_budget"][data-val="full_conversation"]      { background: #7c3aed; border-color: #c084fc; color: #fff; }

  /* retrieval_need colors */
  .opt.selected[data-dim="retrieval_need"][data-val="none"]               { background: #334155; border-color: #94a3b8; color: #f1f5f9; }
  .opt.selected[data-dim="retrieval_need"][data-val="memory"]             { background: #7c3aed; border-color: #c084fc; color: #fff; }
  .opt.selected[data-dim="retrieval_need"][data-val="files"]              { background: #0f766e; border-color: #2dd4bf; color: #fff; }
  .opt.selected[data-dim="retrieval_need"][data-val="web"]                { background: #1d4ed8; border-color: #60a5fa; color: #fff; }
  .opt.selected[data-dim="retrieval_need"][data-val="browser"]            { background: #3730a3; border-color: #a5b4fc; color: #fff; }
  .opt.selected[data-dim="retrieval_need"][data-val="email_calendar"]     { background: #b45309; border-color: #fbbf24; color: #fff; }
  .opt.selected[data-dim="retrieval_need"][data-val="system_local_state"] { background: #b91c1c; border-color: #f87171; color: #fff; }
  .opt.selected[data-dim="retrieval_need"][data-val="other"]              { background: #4b5563; border-color: #9ca3af; color: #f1f5f9; }

  /* work_complexity colors */
  .opt.selected[data-dim="work_complexity"][data-val="trivial"]    { background: #334155; border-color: #94a3b8; color: #f1f5f9; }
  .opt.selected[data-dim="work_complexity"][data-val="simple"]     { background: #166534; border-color: #4ade80; color: #fff; }
  .opt.selected[data-dim="work_complexity"][data-val="moderate"]   { background: #1d4ed8; border-color: #60a5fa; color: #fff; }
  .opt.selected[data-dim="work_complexity"][data-val="complex"]    { background: #7c3aed; border-color: #c084fc; color: #fff; }
  .opt.selected[data-dim="work_complexity"][data-val="multi_step"] { background: #b45309; border-color: #fbbf24; color: #fff; }

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
    font-size: 11px;
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
    font-size: 11px;
    font-weight: 500;
    margin-top: 6px;
  }

  .debug-row {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px dashed var(--border);
    display: flex;
    gap: 8px;
  }

  .debug-toggle {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 3px 9px;
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
    margin-top: 8px;
    padding: 10px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 10.5px;
    line-height: 1.55;
    color: var(--text-2);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 300px;
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

  /* ─── Aggregate strip ─── */

  .aggregate {
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    padding: 16px 18px;
  }

  .aggregate.escalated { border-color: var(--amber); }

  .agg-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 16px;
    margin-bottom: 14px;
    padding-bottom: 14px;
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

  .next-step {
    font-size: 13px;
    color: var(--text-2);
    line-height: 1.55;
  }

  .next-step .label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 6px;
    display: block;
  }

  .escalation-note {
    margin-top: 10px;
    padding: 8px 12px;
    background: var(--amber-bg);
    color: var(--amber);
    border: 1px solid var(--amber);
    border-radius: 6px;
    font-size: 12px;
  }
</style>
</head>
<body>

<header>
  <h1>open-classify</h1>
  <span class="sub" id="sub-line">—</span>
  <span class="status" id="status">ready</span>
</header>

<div class="main">

  <div class="input-pane">
    <label for="prompt">Inbound message</label>
    <textarea id="prompt" placeholder="Type a user message to classify…&#10;&#10;Press Cmd/Ctrl+Enter to submit." autofocus></textarea>
    <div class="input-actions">
      <button class="primary" id="submit-btn" onclick="submitClassify()">Classify</button>
      <span class="hint">Cmd/Ctrl+Enter</span>
      <span class="char-count" id="char-count">0 chars</span>
    </div>
  </div>

  <div class="results-pane" id="results">
    <div class="empty">Submit a message to see the live classification.</div>
  </div>

</div>

<script>
  // Populated from the server's "started" event (derived from the classifier
  // registry). Frontend renders one card per non-awk entry, with one option
  // pill per enum value — no hardcoded lists.
  let DIM_OPTIONS = {};
  function dimLabel(dim) { return dim.replace(/_/g, ' '); }

  const promptEl = document.getElementById('prompt');
  const submitBtn = document.getElementById('submit-btn');
  const charCount = document.getElementById('char-count');
  const results = document.getElementById('results');
  const statusEl = document.getElementById('status');
  const subLine = document.getElementById('sub-line');

  // Per-run state
  let thresholds = { avg_confidence: 0.65, min_confidence: 0.4 };
  let collected = {}; // dim -> SubEvent

  promptEl.addEventListener('input', () => {
    charCount.textContent = promptEl.value.length + ' chars';
  });

  promptEl.addEventListener('keydown', (e) => {
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[ch]);
  }

  function buildSkeleton(models) {
    results.innerHTML = '';

    // Awk hero
    const hero = document.createElement('div');
    hero.className = 'awk-hero pending';
    hero.id = 'card-awk';
    hero.innerHTML = \`
      <div class="awk-top">
        <div class="awk-label">awk · instant response</div>
        <div class="awk-meta">
          <span class="model-name">\${escapeHtml(shortModel(models.awk))}</span>
          <span class="latency">—</span>
        </div>
      </div>
      <div class="awk-text placeholder">awaiting classifier…</div>
      <div class="awk-badges"></div>
      <div class="awk-conf-row">
        <span class="conf-label">confidence</span>
        <div class="conf-track"><div class="conf-fill"></div></div>
        <span class="conf-num">—</span>
      </div>
      <div class="pending-state" style="margin-top:10px"><span class="spinner"></span> generating awk…</div>
      <div class="debug-row" style="display:none">
        <button class="debug-toggle" data-target="raw">raw output</button>
        <button class="debug-toggle" data-target="prompt">prompt</button>
      </div>
      <div class="debug-content" data-kind="raw"></div>
      <div class="debug-content" data-kind="prompt"></div>
    \`;
    results.appendChild(hero);

    // One card per non-awk classifier in the registry.
    const grid = document.createElement('div');
    grid.className = 'card-grid';
    Object.keys(DIM_OPTIONS).forEach((dim) => {
      const card = document.createElement('div');
      card.className = 'dim-card pending';
      card.id = 'card-' + dim;

      const optsHtml = DIM_OPTIONS[dim].map(opt => \`
        <div class="opt" data-dim="\${dim}" data-val="\${opt}">\${opt.replace(/_/g, ' ')}</div>
      \`).join('');

      card.innerHTML = \`
        <div class="dim-header">
          <div class="dim-name">\${dimLabel(dim)}</div>
          <div class="dim-meta">
            <span class="model-name">\${escapeHtml(shortModel(models[dim]))}</span>
            <span class="latency">—</span>
          </div>
        </div>
        <div class="dim-options">\${optsHtml}</div>
        <div class="conf-row">
          <span class="conf-label">confidence</span>
          <div class="conf-track"><div class="conf-fill"></div></div>
          <span class="conf-num">—</span>
        </div>
        <div class="pending-state" style="margin-top:8px"><span class="spinner"></span> waiting…</div>
        <div class="debug-row" style="display:none">
          <button class="debug-toggle" data-target="raw">raw</button>
          <button class="debug-toggle" data-target="prompt">prompt</button>
        </div>
        <div class="debug-content" data-kind="raw"></div>
        <div class="debug-content" data-kind="prompt"></div>
      \`;
      grid.appendChild(card);
    });
    results.appendChild(grid);

    // Aggregate strip (hidden until complete)
    const agg = document.createElement('div');
    agg.className = 'aggregate';
    agg.id = 'aggregate';
    agg.style.display = 'none';
    results.appendChild(agg);
  }

  function shortModel(m) {
    if (!m) return '—';
    return m.replace(/^ollama\\//, '').replace(/^openai\\//, 'oa/');
  }

  function wireDebugToggles(card) {
    card.querySelectorAll('.debug-toggle').forEach(btn => {
      btn.onclick = () => {
        const target = btn.getAttribute('data-target');
        const panel = card.querySelector('.debug-content[data-kind="' + target + '"]');
        const isOpen = panel.classList.contains('show');
        card.querySelectorAll('.debug-content').forEach(p => p.classList.remove('show'));
        card.querySelectorAll('.debug-toggle').forEach(b => b.classList.remove('active'));
        if (!isOpen) {
          panel.classList.add('show');
          btn.classList.add('active');
        }
      };
    });
  }

  function fillDebug(card, raw, prompt) {
    const debugRow = card.querySelector('.debug-row');
    const rawPanel = card.querySelector('.debug-content[data-kind="raw"]');
    const promptPanel = card.querySelector('.debug-content[data-kind="prompt"]');
    if (debugRow) debugRow.style.display = '';
    if (rawPanel) rawPanel.innerHTML = '<div class="label">model raw output</div>' + escapeHtml(raw || '(empty)');
    if (promptPanel) promptPanel.innerHTML = '<div class="label">system prompt</div>' + escapeHtml(prompt || '');
    wireDebugToggles(card);
  }

  function updateAwkCard(event) {
    const card = document.getElementById('card-awk');
    if (!card) return;
    card.classList.remove('pending');

    const latEl = card.querySelector('.latency');
    const fillEl = card.querySelector('.conf-fill');
    const numEl = card.querySelector('.conf-num');
    const pendingEl = card.querySelector('.pending-state');
    const textEl = card.querySelector('.awk-text');
    const badgesEl = card.querySelector('.awk-badges');

    if (pendingEl) pendingEl.remove();
    latEl.textContent = event.latency_ms + 'ms';
    fillDebug(card, event.raw_output, event.prompt);

    if (!event.data) {
      card.classList.add('failed');
      textEl.textContent = '✕ classifier failed (' + (event.validation_status || 'unknown') + ')';
      textEl.className = 'awk-text';
      textEl.style.color = 'var(--red)';
      badgesEl.innerHTML = '';
      numEl.textContent = '—';
      return;
    }

    card.classList.add('done');
    const d = event.data;
    textEl.textContent = '"' + d.text + '"';
    textEl.className = 'awk-text';

    badgesEl.innerHTML = \`
      <span class="mode-pill" data-mode="\${d.mode}">\${d.mode}</span>
      <span class="send-badge \${d.should_send ? 'on' : 'off'}">\${d.should_send ? 'send' : 'silent'}</span>
    \`;

    const pct = Math.round(d.confidence * 100);
    fillEl.style.width = pct + '%';
    fillEl.style.background = confColor(d.confidence);
    numEl.textContent = pct + '%';
    numEl.className = 'conf-num ' + confClass(d.confidence);
  }

  function updateDimCard(dim, event) {
    const card = document.getElementById('card-' + dim);
    if (!card) return;
    card.classList.remove('pending');

    const latEl = card.querySelector('.latency');
    const fillEl = card.querySelector('.conf-fill');
    const numEl = card.querySelector('.conf-num');
    const pendingEl = card.querySelector('.pending-state');

    if (pendingEl) pendingEl.remove();
    latEl.textContent = event.latency_ms + 'ms';
    fillDebug(card, event.raw_output, event.prompt);

    if (!event.data) {
      card.classList.add('failed');
      const fail = document.createElement('div');
      fail.className = 'failed-state';
      fail.textContent = '✕ classifier failed (' + (event.validation_status || 'unknown') + ')';
      const debugRow = card.querySelector('.debug-row');
      card.insertBefore(fail, debugRow);
      numEl.textContent = '—';
      return;
    }

    card.classList.add('done');
    const value = event.data.value;
    const values = Array.isArray(value) ? value : [value];

    card.querySelectorAll('.opt').forEach(opt => {
      const v = opt.getAttribute('data-val');
      if (values.includes(v)) opt.classList.add('selected');
    });

    const pct = Math.round(event.data.confidence * 100);
    fillEl.style.width = pct + '%';
    fillEl.style.background = confColor(event.data.confidence);
    numEl.textContent = pct + '%';
    numEl.className = 'conf-num ' + confClass(event.data.confidence);
  }

  function nextStepSentence(awk, responsePath, retrieval, contextBudget, complexity) {
    if (!awk || !awk.data) return 'Classification incomplete.';
    const a = awk.data;
    if (a.mode === 'only') return 'Send the awk and stop. No further work.';
    if (a.mode === 'question') return 'Send the clarification question and wait for the user.';

    const rp = responsePath?.data?.value;
    const rNeeds = retrieval?.data?.value || [];
    const ctx = contextBudget?.data?.value;
    const cx = complexity?.data?.value;

    if (!rp || rp === 'none') return 'Send the awk; no downstream action.';

    const pieces = ['Send awk, then route to ' + rp.replace(/_/g, ' ')];
    if (ctx && ctx !== 'none' && ctx !== 'current_message_only') pieces.push('with ' + ctx.replace(/_/g, ' '));
    if (rNeeds.length && !rNeeds.includes('none')) pieces.push('using ' + rNeeds.join(' + '));
    if (cx) pieces.push('— ' + cx + ' work');
    return pieces.join(' ') + '.';
  }

  function applyLowConfidenceOverride(avg, min) {
    const triggered = avg < thresholds.avg_confidence || min < thresholds.min_confidence;
    if (!triggered) return false;

    // Override the awk hero
    const awkCard = document.getElementById('card-awk');
    if (awkCard && !awkCard.classList.contains('failed')) {
      awkCard.classList.add('overridden');
      const textEl = awkCard.querySelector('.awk-text');
      const badgesEl = awkCard.querySelector('.awk-badges');
      const original = textEl.textContent;
      textEl.innerHTML = '<span class="overridden">[overridden] Need more detail before I can act on this.</span>';
      textEl.title = 'Original: ' + original;
      if (badgesEl) {
        badgesEl.innerHTML = \`
          <span class="mode-pill" data-mode="question">question</span>
          <span class="send-badge on">send</span>
        \`;
      }
    }

    // Override the response_path card
    const rpCard = document.getElementById('card-response_path');
    if (rpCard && !rpCard.classList.contains('failed')) {
      rpCard.classList.add('overridden');
      rpCard.querySelectorAll('.opt').forEach(opt => opt.classList.remove('selected'));
      const noneOpt = rpCard.querySelector('.opt[data-val="none"]');
      if (noneOpt) noneOpt.classList.add('selected');
    }

    return true;
  }

  function renderAggregate(totalLatencyMs) {
    const agg = document.getElementById('aggregate');
    if (!agg) return;

    // Gather confidences from successful sub_results only.
    const dims = Object.keys(collected);
    const confs = dims
      .map(d => collected[d]?.data?.confidence)
      .filter(c => typeof c === 'number');

    let avg = 0, min = 0;
    if (confs.length) {
      avg = confs.reduce((a, b) => a + b, 0) / confs.length;
      min = Math.min(...confs);
    }

    // Override only when every classifier (awk + each non-awk dim) has settled.
    const expected = 1 + Object.keys(DIM_OPTIONS).length;
    const overridden = confs.length === expected && applyLowConfidenceOverride(avg, min);

    agg.style.display = '';
    agg.className = 'aggregate' + (overridden ? ' escalated' : '');

    const avgPct = Math.round(avg * 100);
    const minPct = Math.round(min * 100);

    const sentence = nextStepSentence(
      collected.awk,
      collected.response_path,
      collected.retrieval_need,
      collected.context_budget,
      collected.work_complexity
    );

    const overrideSentence = overridden
      ? '<div class="escalation-note">⚠ Low confidence (avg < ' + Math.round(thresholds.avg_confidence * 100) + '% or min < ' + Math.round(thresholds.min_confidence * 100) + '%) — forcing awk.mode=question, response_path=none.</div>'
      : '';

    agg.innerHTML = \`
      <div class="agg-grid">
        <div class="agg-stat">
          <div class="label">average confidence</div>
          <div class="value \${confClass(avg)}">\${avgPct}%</div>
          <div class="sub">across all classifiers</div>
        </div>
        <div class="agg-stat">
          <div class="label">min confidence</div>
          <div class="value \${confClass(min)}">\${minPct}%</div>
          <div class="sub">lowest single classifier</div>
        </div>
        <div class="agg-stat">
          <div class="label">total latency</div>
          <div class="value">\${totalLatencyMs}<span style="font-size:14px;color:var(--muted)">ms</span></div>
          <div class="sub">wall-clock</div>
        </div>
      </div>
      <div class="next-step">
        <span class="label">next step</span>
        \${overridden ? 'Awaiting clarification — send the question and stop.' : escapeHtml(sentence)}
      </div>
      \${overrideSentence}
    \`;
  }

  async function submitClassify() {
    const val = promptEl.value.trim();
    if (!val) return;

    submitBtn.disabled = true;
    statusEl.textContent = 'classifying…';
    collected = {};

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
            thresholds = event.thresholds;
            DIM_OPTIONS = event.classifier_options || {};
            const models = event.classifier_models;
            const uniq = [...new Set(Object.values(models))];
            subLine.textContent = uniq.length === 1
              ? shortModel(uniq[0])
              : uniq.length + ' distinct models';
            buildSkeleton(models);
          } else if (event.type === 'sub_result') {
            collected[event.dimension] = event;
            if (event.dimension === 'awk') updateAwkCard(event);
            else updateDimCard(event.dimension, event);
          } else if (event.type === 'complete') {
            renderAggregate(event.total_latency_ms);
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
