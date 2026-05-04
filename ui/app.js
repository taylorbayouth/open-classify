const DEFAULT_CLASSIFIER_NAMES = [
  "preflight",
  "downstream_route",
  "additional_history_need",
  "memory_retrieval_queries",
  "tool_family_need",
  "message_and_attachment_digest",
  "security_posture",
];

const labels = {
  preflight: "Preflight",
  downstream_route: "Downstream route",
  additional_history_need: "History need",
  memory_retrieval_queries: "Memory queries",
  tool_family_need: "Tool families",
  message_and_attachment_digest: "Message digest",
  security_posture: "Security posture",
};

const optionKeys = {
  preflight: "terminality",
  downstream_route: "downstream_route",
  additional_history_need: "additional_history_need",
  tool_family_need: "tool_family",
  security_posture: "security_posture",
};

const PHASE_LABELS = {
  normalizing: "Normalizing input",
  resource_check: "Checking Ollama resources",
  running: "Running classifiers",
};

const state = {
  metadata: null,
  attachments: [],
  classifierNames: [...DEFAULT_CLASSIFIER_NAMES],
  classifiers: {},
  events: [],
  eventCount: 0,
  phase: "idle",
  tickerHandle: null,
};

const form = document.querySelector("#classifyForm");
const attachmentInput = document.querySelector("#attachmentInput");
const attachmentList = document.querySelector("#attachmentList");
const classifierGrid = document.querySelector("#classifierGrid");
const runState = document.querySelector("#runState");
const liveDot = document.querySelector("#liveDot");
const awkDisplay = document.querySelector("#awkDisplay");
const awkValue = document.querySelector("#awkValue");
const hashes = document.querySelector("#hashes");
const jsonPanel = document.querySelector("#jsonPanel");
const jsonToggle = document.querySelector("#jsonToggle");
const metaChips = document.querySelector("#metaChips");
const clearButton = document.querySelector("#clearButton");
const runButton = document.querySelector("#runButton");
const copyJsonButton = document.querySelector("#copyJsonButton");
const eventLogList = document.querySelector("#eventLogList");
const eventLogCount = document.querySelector("#eventLogCount");

init();

async function init() {
  const response = await fetch("/api/metadata");
  state.metadata = await response.json();
  renderMetaChips();
  resetClassifiers("idle");
  renderAttachments();
  startTicker();

  attachmentInput.addEventListener("change", () => {
    state.attachments = Array.from(attachmentInput.files ?? []).map((file) => ({
      filename: file.name,
      size_bytes: file.size,
      mime_type: file.type || undefined,
    }));
    renderAttachments();
  });

  clearButton.addEventListener("click", () => {
    form.reset();
    state.attachments = [];
    attachmentInput.value = "";
    state.events = [];
    state.eventCount = 0;
    renderEventLog();
    resetClassifiers("idle");
    renderAttachments();
    setRunState("idle");
    awkDisplay.hidden = true;
    hashes.hidden = true;
    jsonToggle.hidden = true;
    jsonToggle.removeAttribute("open");
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void classify();
  });

  copyJsonButton.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = jsonPanel.textContent ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copyJsonButton.textContent = "Copied";
      setTimeout(() => (copyJsonButton.textContent = "Copy"), 1500);
    } catch {
      copyJsonButton.textContent = "Failed";
      setTimeout(() => (copyJsonButton.textContent = "Copy"), 1500);
    }
  });
}

function renderMetaChips() {
  if (!state.metadata) {
    metaChips.innerHTML = "";
    return;
  }
  const chips = [
    ["model", state.metadata.base_model],
    ["parallel", `${state.metadata.ollama_required_parallelism}-way`],
    ["ctx", state.metadata.ollama_context_length],
  ];
  metaChips.innerHTML = chips
    .map(([k, v]) => `<span class="chip"><em>${k}</em>${escapeHtml(String(v))}</span>`)
    .join("");
}

async function classify() {
  resetClassifiers();
  state.events = [];
  state.eventCount = 0;
  renderEventLog();
  setRunState("running");
  awkDisplay.hidden = true;
  hashes.hidden = true;
  jsonToggle.hidden = true;
  jsonToggle.removeAttribute("open");
  form.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });

  try {
    const response = await fetch("/api/classify-stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildInput()),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Request failed: ${response.status}`);
    }

    await readEventStream(response.body, handleStreamEvent);
  } catch (error) {
    setRunState("failed");
    appendEvent("error", null, error.message);
  } finally {
    form.querySelectorAll("button").forEach((button) => {
      button.disabled = false;
    });
  }
}

function buildInput() {
  const data = new FormData(form);
  const input = {
    text: String(data.get("text") ?? ""),
    attachments: state.attachments,
  };

  for (const key of [
    "external_request_id",
    "source",
    "conversation_id",
    "thread_id",
    "message_id",
    "timestamp",
  ]) {
    const value = String(data.get(key) ?? "").trim();
    if (value) {
      input[key] = value;
    }
  }

  return input;
}

function handleStreamEvent(event, data) {
  appendEvent(event, data?.name ?? null);

  switch (event) {
    case "pipeline_started":
      if (Array.isArray(data.classifiers) && data.classifiers.length > 0) {
        state.classifierNames = data.classifiers;
      }
      resetClassifiers();
      break;
    case "pipeline_phase":
      setRunState(data.phase === "running" ? "running" : data.phase);
      break;
    case "classifier_started":
      updateClassifier(data.name, {
        status: "running",
        startedAt: performance.now(),
        finishedAt: null,
      });
      break;
    case "classifier_completed":
      updateClassifier(data.name, {
        status: "done",
        result: data.result,
        finishedAt: performance.now(),
      });
      if (data.name === "preflight" && data.result?.awk) {
        showAwk(data.result.awk);
      }
      break;
    case "classifier_canceled":
      updateClassifier(data.name, {
        status: "canceled",
        finishedAt: performance.now(),
      });
      break;
    case "classifier_failed":
      updateClassifier(data.name, {
        status: "failed",
        error: data.error,
        finishedAt: performance.now(),
      });
      break;
    case "pipeline_completed":
      renderPipeline(data);
      break;
    case "pipeline_failed":
      setRunState("failed");
      break;
  }
}

function showAwk(value) {
  awkDisplay.hidden = false;
  awkValue.textContent = value;
}

function renderPipeline(result) {
  setRunState(result.status === "terminal" ? "terminal" : "complete");
  showAwk(result.status === "terminal" ? result.preflight.awk : result.awk);

  hashes.hidden = false;
  hashes.innerHTML = `
    <div><em>message_hash</em>${escapeHtml(result.request.message_hash)}</div>
    <div><em>request_hash</em>${escapeHtml(result.request.request_hash)}</div>
  `;

  jsonToggle.hidden = false;
  jsonPanel.textContent = JSON.stringify(result, null, 2);
}

function resetClassifiers(status = "pending") {
  state.classifiers = Object.fromEntries(
    state.classifierNames.map((name) => [
      name,
      { status, result: null, error: null, startedAt: null, finishedAt: null },
    ]),
  );
  renderClassifiers();
}

function updateClassifier(name, patch) {
  if (!state.classifiers[name]) {
    state.classifiers[name] = {
      status: "pending",
      result: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    };
  }
  state.classifiers[name] = { ...state.classifiers[name], ...patch };
  renderClassifiers();
}

function renderClassifiers() {
  classifierGrid.innerHTML = state.classifierNames.map(renderClassifier).join("");
  updateTickers();
}

function renderClassifier(name) {
  const item = state.classifiers[name] ?? { status: "pending" };
  const result = item.result;
  const optionHtml = renderOptions(name, result);
  const detailHtml = renderDetails(name, item);
  const elapsedHtml = `<span class="elapsed" data-name="${name}">${formatElapsed(item)}</span>`;

  return `
    <article class="classifier-card" data-status="${item.status}">
      <div class="classifier-head">
        <div class="title-block">
          <h2 class="classifier-title">${labels[name] ?? name}</h2>
          <code class="classifier-slug">${name}</code>
        </div>
        <div class="status-block">
          <span class="badge ${item.status}">
            ${item.status === "running" ? '<span class="pulse"></span>' : ""}${item.status}
          </span>
          ${elapsedHtml}
        </div>
      </div>
      ${optionHtml}
      ${detailHtml}
    </article>
  `;
}

function formatElapsed(item) {
  if (!item.startedAt) {
    return "";
  }
  const end = item.finishedAt ?? performance.now();
  const seconds = (end - item.startedAt) / 1000;
  return `${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
}

function startTicker() {
  if (state.tickerHandle) return;
  const tick = () => {
    updateTickers();
    state.tickerHandle = requestAnimationFrame(tick);
  };
  state.tickerHandle = requestAnimationFrame(tick);
}

function updateTickers() {
  for (const name of state.classifierNames) {
    const item = state.classifiers[name];
    if (!item || item.status !== "running" || !item.startedAt) continue;
    const el = classifierGrid.querySelector(`.elapsed[data-name="${name}"]`);
    if (el) el.textContent = formatElapsed(item);
  }
}

function renderOptions(name, result) {
  if (name === "security_posture") {
    return `
      <div class="option-row">${renderEnumOptions("security_posture", result?.value)}</div>
      <div class="option-row">${renderEnumOptions("security_signal", result?.signals ?? [])}</div>
    `;
  }

  const key = optionKeys[name];
  if (!key) return "";

  const selected =
    name === "tool_family_need"
      ? result?.value ?? []
      : result?.value ?? result?.terminality;
  return `<div class="option-row">${renderEnumOptions(key, selected)}</div>`;
}

function renderEnumOptions(key, selected) {
  const selectedValues = new Set(
    Array.isArray(selected) ? selected : selected ? [selected] : [],
  );
  return (state.metadata?.enums?.[key] ?? [])
    .map((option) => {
      const cls = selectedValues.has(option) ? " selected" : "";
      return `<span class="option${cls}">${escapeHtml(option)}</span>`;
    })
    .join("");
}

function renderDetails(name, item) {
  if (item.error) {
    return `<div class="detail error">${escapeHtml(item.error)}</div>`;
  }

  const result = item.result;
  if (!result) {
    return `<div class="detail muted">${emptyStateText(item.status)}</div>`;
  }

  if (name === "preflight") {
    return `<div class="detail">${escapeHtml(result.awk)}</div>`;
  }

  if (name === "memory_retrieval_queries") {
    const queries = result.queries?.length ? result.queries : ["(no queries)"];
    return `<div class="query-row">${queries
      .map((q) => `<span class="query">${escapeHtml(q)}</span>`)
      .join("")}</div>`;
  }

  if (name === "message_and_attachment_digest") {
    return `
      <div class="detail"><strong>${escapeHtml(result.slug)}</strong></div>
      <div class="detail muted">${escapeHtml(result.summary)}</div>
    `;
  }

  if (name === "security_posture") {
    return `<div class="detail muted">${escapeHtml(result.notes)}</div>`;
  }

  return "";
}

function emptyStateText(status) {
  if (status === "running") return "Running…";
  if (status === "canceled") return "Canceled by preflight";
  if (status === "failed") return "Failed";
  if (status === "pending") return "Queued";
  return "Awaiting run";
}

function renderAttachments() {
  if (state.attachments.length === 0) {
    attachmentList.innerHTML = "";
    return;
  }
  attachmentList.innerHTML = state.attachments
    .map(
      (a) => `
        <div class="attachment">
          <strong>${escapeHtml(a.filename)}</strong>
          <span>${formatBytes(a.size_bytes)} · ${escapeHtml(a.mime_type || "unknown")}</span>
        </div>
      `,
    )
    .join("");
}

function appendEvent(event, classifier, message) {
  state.eventCount += 1;
  const timestamp = new Date();
  const entry = {
    id: state.eventCount,
    event,
    classifier,
    message,
    timestamp,
  };
  state.events.unshift(entry);
  if (state.events.length > 50) state.events.length = 50;
  renderEventLog();
}

function renderEventLog() {
  eventLogCount.textContent = `${state.eventCount} event${state.eventCount === 1 ? "" : "s"}`;
  eventLogList.innerHTML = state.events
    .map((e) => {
      const time = e.timestamp.toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const ms = String(e.timestamp.getMilliseconds()).padStart(3, "0");
      const tag = eventTag(e.event);
      const detail = e.classifier
        ? `<span class="ev-classifier">${escapeHtml(e.classifier)}</span>`
        : e.message
        ? `<span class="ev-message">${escapeHtml(e.message)}</span>`
        : "";
      return `
        <li class="ev ev-${tag.kind}">
          <span class="ev-time">${time}.${ms}</span>
          <span class="ev-name">${escapeHtml(e.event)}</span>
          ${detail}
        </li>
      `;
    })
    .join("");
}

function eventTag(name) {
  if (name.endsWith("_completed") || name === "pipeline_completed") return { kind: "ok" };
  if (name.endsWith("_failed") || name === "error") return { kind: "err" };
  if (name.endsWith("_canceled")) return { kind: "warn" };
  if (name.endsWith("_started") || name === "pipeline_phase") return { kind: "info" };
  return { kind: "info" };
}

async function readEventStream(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const parsed = parseSseEvent(part);
      if (parsed) onEvent(parsed.event, parsed.data);
    }
  }
}

function parseSseEvent(chunk) {
  const lines = chunk.split("\n").filter((line) => !line.startsWith(":"));
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (!eventLine || !dataLine) return null;

  try {
    return {
      event: eventLine.slice(7).trim(),
      data: JSON.parse(dataLine.slice(6)),
    };
  } catch {
    return null;
  }
}

function setRunState(value) {
  state.phase = value;
  const labelMap = {
    idle: "Idle",
    normalizing: "Normalizing",
    resource_check: "Resource check",
    running: "Running",
    complete: "Complete",
    terminal: "Terminal",
    failed: "Failed",
  };
  runState.textContent = labelMap[value] ?? value;
  runState.dataset.state = value;
  liveDot.dataset.state = value;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
