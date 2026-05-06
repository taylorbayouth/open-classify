const DEFAULT_CLASSIFIER_NAMES = [
  "preflight",
  "routing",
  "context_sufficiency",
  "memory_retrieval_queries",
  "tools",
  "message_and_attachment_digest",
  "security",
];

const labels = {
  preflight: "Preflight",
  routing: "Routing",
  context_sufficiency: "Context sufficiency",
  memory_retrieval_queries: "Memory queries",
  tools: "Tools",
  message_and_attachment_digest: "Message digest",
  security: "Security",
};

const optionKeys = {
  preflight: "terminality",
  context_sufficiency: "context_sufficiency",
  tools: "tool_family",
  security: "security_risk_level",
};

const enumValueLabels = {
  // terminality
  terminal: "Terminal",
  continue: "Continue",
  // execution mode
  direct: "Direct",
  tool_assisted: "Tool assisted",
  workflow: "Workflow",
  // model tier
  local_fast: "Local fast",
  local_strong: "Local strong",
  frontier_fast: "Frontier fast",
  frontier_strong: "Frontier strong",
  // context sufficiency
  self_contained: "Self-contained",
  adjacent_context_helpful: "Adjacent context helpful",
  referential: "Referential",
  incomplete_information: "Incomplete information",
  long_context: "Long context",
  // tool families
  workspace: "Workspace",
  web: "Web",
  communications: "Communications",
  documents: "Documents",
  spreadsheets: "Spreadsheets",
  project_management: "Project management",
  developer_platforms: "Dev platforms",
  // security risk
  normal: "Normal",
  suspicious: "Suspicious",
  high_risk: "High risk",
  // security signals
  instruction_attack: "Instruction attack",
  secret_or_private_data_risk: "Private data risk",
  unsafe_tool_or_action: "Unsafe tool/action",
  untrusted_content_or_code: "Untrusted content",
  injection_or_obfuscation: "Injection/obfuscation",
  // common
  unable_to_determine: "Unable to determine",
};

const PHASE_LABELS = {
  normalizing: "Normalizing input",
  resource_check: "Checking Ollama resources",
  running: "Running classifiers",
};

const state = {
  metadata: null,
  attachments: [],
  messages: [createMessage()],
  samples: [],
  classifierNames: [...DEFAULT_CLASSIFIER_NAMES],
  classifiers: {},
  events: [],
  eventCount: 0,
  phases: [],
  tickerHandle: null,
};

const form = document.querySelector("#classifyForm");
const messageList = document.querySelector("#messageList");
const addMessageButton = document.querySelector("#addMessageButton");
const sampleButton = document.querySelector("#sampleButton");
const attachmentInput = document.querySelector("#attachmentInput");
const attachmentList = document.querySelector("#attachmentList");
const classifierGrid = document.querySelector("#classifierGrid");
const runState = document.querySelector("#runState");
const liveDot = document.querySelector("#liveDot");
const replyDisplay = document.querySelector("#replyDisplay");
const replyValue = document.querySelector("#replyValue");
const hashes = document.querySelector("#hashes");
const jsonPanel = document.querySelector("#jsonPanel");
const jsonToggle = document.querySelector("#jsonToggle");
const metaChips = document.querySelector("#metaChips");
const clearButton = document.querySelector("#clearButton");
const runButton = document.querySelector("#runButton");
const copyJsonButton = document.querySelector("#copyJsonButton");
const eventLogList = document.querySelector("#eventLogList");
const eventLogCount = document.querySelector("#eventLogCount");
const phaseTrail = document.querySelector("#phaseTrail");

init();

async function init() {
  const response = await fetch("/api/metadata");
  state.metadata = await response.json();
  state.samples = await loadSamples();
  renderMetaChips();
  resetClassifiers("idle");
  renderMessages();
  renderAttachments();
  startTicker();

  messageList.addEventListener("keydown", (event) => {
    if (!event.target.matches("textarea")) return;
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.isComposing
    ) {
      return;
    }

    event.preventDefault();
    if (!runButton.disabled) {
      form.requestSubmit();
    }
  });

  attachmentInput.addEventListener("change", () => {
    state.attachments = [
      ...state.attachments,
      ...Array.from(attachmentInput.files ?? []).map((file) => ({
        filename: file.name,
        size_bytes: file.size,
        mime_type: file.type || undefined,
      })),
    ];
    attachmentInput.value = "";
    renderAttachments();
  });

  addMessageButton.addEventListener("click", () => {
    state.messages.push(createMessage());
    renderMessages();
    focusLastMessage();
  });

  sampleButton.addEventListener("click", () => {
    loadRandomSample();
  });

  messageList.addEventListener("input", (event) => {
    const field = event.target.closest("[data-field]");
    const item = event.target.closest("[data-message-id]");
    if (!field || !item) return;

    const message = state.messages.find((candidate) => candidate.id === item.dataset.messageId);
    if (!message) return;
    message[field.dataset.field] = event.target.value;
  });

  messageList.addEventListener("change", (event) => {
    const field = event.target.closest("[data-field]");
    const item = event.target.closest("[data-message-id]");
    if (!field || !item) return;

    const message = state.messages.find((candidate) => candidate.id === item.dataset.messageId);
    if (!message) return;
    message[field.dataset.field] = event.target.value;
  });

  messageList.addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-remove-message]");
    if (!removeButton) return;

    if (state.messages.length === 1) return;
    state.messages = state.messages.filter(
      (message) => message.id !== removeButton.dataset.removeMessage,
    );
    state.messages[state.messages.length - 1].role = "user";
    renderMessages();
  });

  clearButton.addEventListener("click", () => {
    form.reset();
    state.attachments = [];
    state.messages = [createMessage()];
    attachmentInput.value = "";
    resetRunOutput();
    renderMessages();
    renderAttachments();
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

async function loadSamples() {
  try {
    const response = await fetch("/test-conversations.jsonl");
    if (!response.ok) return [];
    const text = await response.text();
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    sampleButton.disabled = true;
    sampleButton.title = "Sample data could not be loaded";
    return [];
  }
}

function loadRandomSample() {
  if (state.samples.length === 0) return;

  const sample = state.samples[Math.floor(Math.random() * state.samples.length)];
  for (const key of ["source", "external_request_id", "conversation_id", "thread_id"]) {
    form.elements[key].value = sample[key] ?? "";
  }

  state.attachments = Array.isArray(sample.attachments) ? sample.attachments : [];
  state.messages = sample.conversation_window.map((message) => ({
    ...createMessage(),
    ...message,
  }));
  state.messages[state.messages.length - 1].role = "user";
  attachmentInput.value = "";
  resetRunOutput();
  renderMessages();
  renderAttachments();
  messageList.scrollIntoView({ behavior: "smooth", block: "start" });
  const inputs = messageList.querySelectorAll("textarea[data-field='text']");
  inputs[inputs.length - 1]?.focus({ preventScroll: true });
}

function resetRunOutput() {
  state.events = [];
  state.eventCount = 0;
  renderEventLog();
  resetClassifiers("idle");
  setRunState("idle");
  replyDisplay.hidden = true;
  hashes.hidden = true;
  jsonToggle.hidden = true;
  jsonToggle.removeAttribute("open");
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
  replyDisplay.hidden = true;
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
  const messages = state.messages.map(toConversationMessage);
  messages[messages.length - 1].role = "user";

  const input = {
    conversation_window: messages,
    attachments: state.attachments,
  };

  for (const key of [
    "external_request_id",
    "source",
    "conversation_id",
    "thread_id",
  ]) {
    const value = String(data.get(key) ?? "").trim();
    if (value) {
      input[key] = value;
    }
  }

  return input;
}

function createMessage() {
  return {
    id: crypto.randomUUID(),
    role: "user",
    text: "",
    message_id: "",
    timestamp: "",
  };
}

function toConversationMessage(message) {
  const output = {
    role: message.role || "user",
    text: message.text,
  };

  for (const key of ["message_id", "timestamp"]) {
    const value = String(message[key] ?? "").trim();
    if (value) {
      output[key] = value;
    }
  }

  return output;
}

function renderMessages() {
  messageList.innerHTML = state.messages
    .map((message, index) => renderMessage(message, index))
    .join("");
}

function renderMessage(message, index) {
  const isFinal = index === state.messages.length - 1;
  const canRemove = state.messages.length > 1;
  if (isFinal) {
    message.role = "user";
  }

  return `
    <article class="message-editor ${isFinal ? "target-message" : "context-message"}" data-message-id="${escapeHtml(message.id)}">
      <div class="message-editor-head">
        <strong>Message ${index + 1}</strong>
        <span>${isFinal ? "classified message" : "context"}</span>
        <button class="icon-button" type="button" data-remove-message="${escapeHtml(message.id)}" title="Remove message" aria-label="Remove message"${canRemove ? "" : " disabled"}>×</button>
      </div>
      <div class="message-meta-row">
        <label class="field">
          <span>Role</span>
          <select data-field="role"${isFinal ? " disabled" : ""}>
            ${["user", "assistant"]
              .map((role) => `<option value="${role}"${message.role === role ? " selected" : ""}>${role}</option>`)
              .join("")}
          </select>
        </label>
        <label class="field">
          <span>Message ID</span>
          <input data-field="message_id" value="${escapeHtml(message.message_id)}" placeholder="M122" />
        </label>
        <label class="field">
          <span>Timestamp</span>
          <input data-field="timestamp" value="${escapeHtml(message.timestamp)}" placeholder="2026-05-04T11:59:00Z" />
        </label>
      </div>
      <label class="field">
        <span>Text</span>
        <textarea data-field="text" rows="${isFinal ? 5 : 4}" placeholder="${isFinal ? "Latest user message to classify..." : "Earlier message text..."}" required>${escapeHtml(message.text)}</textarea>
      </label>
    </article>
  `;
}

function focusLastMessage() {
  const inputs = messageList.querySelectorAll("textarea[data-field='text']");
  inputs[inputs.length - 1]?.focus();
}

function handleStreamEvent(event, data) {
  if (event !== "pipeline_phase") appendEvent(event, data?.name ?? null);

  switch (event) {
    case "pipeline_started":
      if (Array.isArray(data.classifiers) && data.classifiers.length > 0) {
        state.classifierNames = data.classifiers;
      }
      state.phases = [];
      renderPhaseTrail();
      resetClassifiers();
      break;
    case "pipeline_phase":
      setRunState(data.phase === "running" ? "running" : data.phase);
      state.phases.push(data.phase);
      renderPhaseTrail();
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
      if (data.name === "preflight" && data.result?.reply) {
        showReply(data.result.reply);
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

function showReply(value) {
  replyDisplay.hidden = false;
  replyValue.textContent = value;
}

function renderPipeline(result) {
  setRunState(result.decision === "terminal" ? "terminal" : "complete");
  showReply(result.decision === "terminal" ? result.preflight.reply : result.reply);

  if (result.decision === "terminal") {
    cancelUnfinishedClassifiers();
  } else if (result.classifiers) {
    for (const name of Object.keys(result.classifiers)) {
      const status = result.classifier_status?.[name];
      updateClassifier(name, {
        status: status?.ok === false ? "fallback" : "done",
        result: result.classifiers[name],
        error: status?.ok === false ? status.error : null,
        finishedAt: performance.now(),
      });
    }
  }

  hashes.hidden = false;
  hashes.innerHTML = `
    <div><em>message_hash</em>${escapeHtml(result.request.message_hash)}</div>
    <div><em>request_hash</em>${escapeHtml(result.request.request_hash)}</div>
  `;

  jsonToggle.hidden = false;
  jsonPanel.textContent = JSON.stringify(result, null, 2);
}

function cancelUnfinishedClassifiers() {
  for (const name of state.classifierNames) {
    if (name === "preflight") {
      continue;
    }

    const item = state.classifiers[name];
    if (!item || !["pending", "running"].includes(item.status)) {
      continue;
    }

    state.classifiers[name] = {
      ...item,
      status: "canceled",
      finishedAt: performance.now(),
    };
  }
  renderClassifiers();
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
  if (name === "security") {
    return `
      <div class="option-row">${renderEnumOptions("security_risk_level", result?.risk_level)}</div>
      <div class="option-row">${renderEnumOptions("security_signal", result?.signals ?? [])}</div>
    `;
  }

  if (name === "routing") {
    return `
      ${renderLabeledEnumOptions("execution", "downstream_execution_mode", result?.execution_mode)}
      ${renderLabeledEnumOptions("model tier", "downstream_model_tier", result?.model_tier)}
    `;
  }

  const key = optionKeys[name];
  if (!key) return "";

  const selected =
    name === "tools"
      ? result?.families ?? []
      : result?.value ?? result?.terminality;
  return `<div class="option-row">${renderEnumOptions(key, selected)}</div>`;
}

function renderLabeledEnumOptions(label, key, selected) {
  return `
    <div class="option-group">
      <span class="option-label">${escapeHtml(label)}</span>
      <div class="option-row">${renderEnumOptions(key, selected)}</div>
    </div>
  `;
}

function renderEnumOptions(key, selected) {
  const selectedValues = new Set(
    Array.isArray(selected) ? selected : selected ? [selected] : [],
  );
  return (state.metadata?.enums?.[key] ?? [])
    .map((option) => {
      const cls = selectedValues.has(option) ? " selected" : "";
      return `<span class="option${cls}" title="${escapeHtml(option)}">${escapeHtml(enumValueLabels[option] ?? option)}</span>`;
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
    return `<div class="detail">${escapeHtml(result.reply)}</div>`;
  }

  if (name === "memory_retrieval_queries") {
    const queries = result.queries?.length ? result.queries : ["(no queries)"];
    return `<div class="query-row">${queries
      .map((q) => `<span class="query">${escapeHtml(q)}</span>`)
      .join("")}</div>`;
  }

  if (name === "context_sufficiency") {
    const hasMissing = result.missing_context?.length;
    const missingHtml = hasMissing
      ? `<div class="missing-row">${result.missing_context.map((m) => `<span class="missing-tag">${escapeHtml(m)}</span>`).join("")}</div>`
      : `<div class="detail muted">No missing context</div>`;
    const summary = result.relevant_context_summary?.trim();
    return `
      ${missingHtml}
      ${summary ? `
        <div class="detail muted context-field-label">Relevant context summary</div>
        <div class="detail context-summary">${escapeHtml(summary)}</div>
      ` : ""}
    `;
  }

  if (name === "message_and_attachment_digest") {
    return `
      <div class="detail"><strong>${escapeHtml(result.slug)}</strong></div>
      <div class="detail">${escapeHtml(result.summary)}</div>
    `;
  }

  if (name === "tools") {
    return `<div class="detail muted">needed: ${result.needed ? "true" : "false"}</div>`;
  }

  if (name === "security") {
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
  if (name.endsWith("_started")) return { kind: "info" };
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

function renderPhaseTrail() {
  const labels = { normalizing: "normalizing", resource_check: "resource check", running: "running" };
  if (state.phases.length === 0) {
    phaseTrail.hidden = true;
    phaseTrail.textContent = "";
    return;
  }
  phaseTrail.hidden = false;
  phaseTrail.innerHTML = state.phases
    .map((p, i) => {
      const isLast = i === state.phases.length - 1;
      return `<span class="phase-step${isLast ? " phase-step-active" : ""}">${labels[p] ?? p}</span>`;
    })
    .join('<span class="phase-sep">→</span>');
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
