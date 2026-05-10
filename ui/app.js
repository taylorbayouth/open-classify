const DEFAULT_CLASSIFIER_NAMES = [
  "preflight",
  "routing",
  "conversation_history",
  "memory_retrieval_queries",
  "tools",
  "model_specialization",
  "security",
];

const labels = {
  preflight: "Preflight",
  routing: "Routing",
  conversation_history: "Conversation history",
  memory_retrieval_queries: "Memory queries",
  tools: "Tools",
  model_specialization: "Model specialization",
  security: "Security",
};

const optionKeys = {
  preflight: "terminality",
  model_specialization: "model_specialization",
  tools: "tool_family",
  security: "security_risk_level",
};

// Populated on init from GET /api/enums — single source of truth is src/enums.ts.
let ENUMS = {};

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
  // model specialization
  chat: "Chat",
  writing: "Writing",
  reasoning: "Reasoning",
  planning: "Planning",
  coding: "Coding",
  instruction_following: "Instruction following",
  unclear: "Unclear",
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
const clearButton = document.querySelector("#clearButton");
const runButton = document.querySelector("#runButton");
const copyJsonButton = document.querySelector("#copyJsonButton");
const eventLogList = document.querySelector("#eventLogList");
const eventLogCount = document.querySelector("#eventLogCount");
const phaseTrail = document.querySelector("#phaseTrail");

init();

async function init() {
  let descriptors;
  [ENUMS, descriptors, state.samples] = await Promise.all([
    fetch("/api/enums").then((r) => r.json()),
    fetch("/api/classifiers").then((r) => r.json()).catch(() => null),
    loadSamples(),
  ]);

  // UI-descriptor protocol: server enumerates the active registry and the
  // UI overrides its defaults from that. Keeps the hardcoded constants as a
  // safe fallback when /api/classifiers isn't available (older servers,
  // offline screenshots, etc.).
  if (Array.isArray(descriptors) && descriptors.length > 0) {
    state.classifierNames = descriptors.map((d) => d.name);
    for (const d of descriptors) {
      labels[d.name] = d.label ?? labels[d.name] ?? d.name;
    }
  }

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
    const response = await fetch("/scenarios.jsonl");
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
  state.attachments = Array.isArray(sample.attachments) ? sample.attachments : [];
  state.messages = sample.messages.map((message) => ({
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
  const messages = state.messages.map(toConversationMessage);
  messages[messages.length - 1].role = "user";

  const input = {
    messages,
    attachments: state.attachments,
  };

  return input;
}

function createMessage() {
  return {
    id: crypto.randomUUID(),
    role: "user",
    text: "",
  };
}

function toConversationMessage(message) {
  const output = {
    role: message.role || "user",
    text: message.text,
  };

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
      </div>
      <label class="field">
        <span>Text</span>
        <textarea data-field="text" rows="${isFinal ? 3 : 4}" placeholder="${isFinal ? "Latest user message to classify..." : "Earlier message text..."}" required>${escapeHtml(message.text)}</textarea>
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
    case "classifier_timed_out":
      updateClassifier(data.name, {
        status: "timeout",
        error: data.reason,
        finishedAt: performance.now(),
      });
      break;
    case "classifier_aborted":
      updateClassifier(data.name, {
        status: "aborted",
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
  if (!value) {
    replyDisplay.hidden = true;
    replyValue.textContent = "";
    return;
  }
  replyDisplay.hidden = false;
  replyValue.textContent = value;
}

function renderPipeline(result) {
  let finalState = "complete";
  if (result.decision === "short_circuit") {
    if (result.kind === "final") finalState = "terminal";
    else if (result.kind === "block") finalState = "block";
    else if (result.kind === "clarify") finalState = "clarify";
  }
  setRunState(finalState);
  // On short_circuit/final and short_circuit/clarify, `reply` is at the top
  // level. On route, the brief acknowledgement (if any) is on `quick_reply`.
  const replyText =
    result.decision === "short_circuit"
      ? result.reply
      : result.quick_reply?.text;
  showReply(replyText);

  if (result.meta?.classifiers) {
    for (const name of Object.keys(result.meta.classifiers)) {
      const entry = result.meta.classifiers[name];
      const status = entry.status;
      const { status: _ignored, version: _v, ...verdict } = entry;
      updateClassifier(name, {
        status: status?.ok === false ? "fallback" : "done",
        result: verdict,
        error: status?.ok === false ? status.error : null,
        finishedAt: performance.now(),
      });
    }
  }

  if (result.decision === "short_circuit") {
    cancelClassifiersExcept(Object.keys(result.meta?.classifiers ?? {}));
  }

  hashes.hidden = false;
  hashes.innerHTML = `
    <div><em>target_message_hash</em>${escapeHtml(result.target_message_hash)}</div>
  `;

  jsonToggle.hidden = false;
  jsonPanel.textContent = JSON.stringify(result, null, 2);
}

function cancelClassifiersExcept(keptNames) {
  const kept = new Set(keptNames);
  for (const name of state.classifierNames) {
    if (kept.has(name)) {
      continue;
    }

    const item = state.classifiers[name] ?? { status: "pending" };
    state.classifiers[name] = {
      ...item,
      status: "aborted",
      result: null,
      error: null,
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
      : result?.model_specialization ?? result?.value ?? result?.terminality;
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
  return (ENUMS[key] ?? [])
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
    return result.reply ? `<div class="detail">${escapeHtml(result.reply)}</div>` : "";
  }

  if (name === "memory_retrieval_queries") {
    const queries = result.queries?.length ? result.queries : ["(no queries)"];
    return `<div class="query-row">${queries
      .map((q) => `<span class="query">${escapeHtml(q)}</span>`)
      .join("")}</div>`;
  }

  if (name === "conversation_history") {
    const history = result.relevant_conversation_history ?? [];
    const n = history.length;
    const msgPill = n > 0
      ? `<span class="option selected">${n} message${n === 1 ? "" : "s"}</span>`
      : "";
    const noHistoryPill = `<span class="option${n === 0 ? " selected" : ""}">No History Needed</span>`;
    const refersClass = result.refers_to_history ? " selected" : "";
    const unseenClass = result.needs_unseen_history ? " selected" : "";
    return `
      <div class="option-row">${msgPill}${noHistoryPill}</div>
      <div class="option-row">
        <span class="option${refersClass}">Refers to History</span>
        <span class="option${unseenClass}">Needs Unseen History</span>
      </div>
      ${result.reason ? `<div class="detail context-summary">${escapeHtml(result.reason)}</div>` : ""}
    `;
  }

  if (name === "model_specialization") {
    return result.reason
      ? `<div class="detail muted">${escapeHtml(result.reason)}</div>`
      : "";
  }

  if (name === "tools") {
    const families = result.families ?? [];
    if (families.length === 0) {
      return `<div class="detail muted">no tools needed</div>`;
    }
    return `<div class="query-row">${families
      .map((f) => `<span class="query">${escapeHtml(f)}</span>`)
      .join("")}</div>`;
  }

  if (name === "security") {
    return `<div class="detail muted">${escapeHtml(result.reason)}</div>`;
  }

  return "";
}

function emptyStateText(status) {
  if (status === "running") return "Running…";
  if (status === "timeout") return "Timed out; retrying";
  if (status === "aborted") return "Aborted by gate";
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
  if (name.endsWith("_timed_out") || name.endsWith("_aborted") || name.endsWith("_canceled")) return { kind: "warn" };
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
    block: "Block",
    clarify: "Clarify",
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
