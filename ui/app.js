let CLASSIFIER_METADATA = {};

const state = {
  messages: [createMessage()],
  samples: [],
  classifierNames: [],
  classifiers: {},
  events: [],
  eventCount: 0,
  pipelineStartedAt: null,
  pipelineCompletedAt: null,
  tickerHandle: null,
  lastResult: null,
};

const form = document.querySelector("#classifyForm");
const messageList = document.querySelector("#messageList");
const addMessageButton = document.querySelector("#addMessageButton");
const sampleButton = document.querySelector("#sampleButton");
const classifierGrid = document.querySelector("#classifierGrid");
const aggregatePanel = document.querySelector("#aggregatePanel");
const liveDot = document.querySelector("#liveDot");
const jsonPanel = document.querySelector("#jsonPanel");
const jsonToggle = document.querySelector("#jsonToggle");
const clearButton = document.querySelector("#clearButton");
const runButton = document.querySelector("#runButton");
const copyJsonButton = document.querySelector("#copyJsonButton");
const eventLogList = document.querySelector("#eventLogList");
const eventLogCount = document.querySelector("#eventLogCount");

init();

async function init() {
  const [classifierResponse, samples] = await Promise.all([
    fetch("/api/classifiers").then((r) => r.json()),
    loadSamples(),
  ]);
  const classifiers = classifierResponse.classifiers ?? [];
  CLASSIFIER_METADATA = Object.fromEntries(classifiers.map((item) => [item.name, item]));
  state.classifierNames = classifiers.map((item) => item.name);
  state.samples = samples;
  resetClassifiers("idle");
  renderMessages();
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
    state.messages = [createMessage()];
    resetRunOutput();
    renderMessages();
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
    const response = await fetch("/test-cases.json");
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch {
    sampleButton.disabled = true;
    sampleButton.title = "Sample data could not be loaded";
    return [];
  }
}

function loadRandomSample() {
  if (state.samples.length === 0) return;

  const sample = state.samples[Math.floor(Math.random() * state.samples.length)];
  state.messages = sample.messages.map((message) => ({
    ...createMessage(),
    ...message,
  }));
  state.messages[state.messages.length - 1].role = "user";
  resetRunOutput();
  renderMessages();
  messageList.scrollIntoView({ behavior: "smooth", block: "start" });
  const inputs = messageList.querySelectorAll("textarea[data-field='text']");
  inputs[inputs.length - 1]?.focus({ preventScroll: true });
}

function resetRunOutput() {
  state.events = [];
  state.eventCount = 0;
  state.pipelineStartedAt = null;
  state.pipelineCompletedAt = null;
  state.lastResult = null;
  renderEventLog();
  resetClassifiers("idle");
  setRunState("idle");
  renderAggregate(null);
  jsonToggle.hidden = true;
  jsonToggle.removeAttribute("open");
  resetCopyJsonButton();
}

async function classify() {
  resetClassifiers();
  state.events = [];
  state.eventCount = 0;
  state.pipelineStartedAt = performance.now();
  state.pipelineCompletedAt = null;
  state.lastResult = null;
  renderEventLog();
  setRunState("running");
  renderAggregate(null);
  jsonToggle.hidden = true;
  jsonToggle.removeAttribute("open");
  resetCopyJsonButton();
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
  return { messages };
}

function createMessage() {
  return {
    id: crypto.randomUUID(),
    role: "user",
    text: "",
  };
}

function toConversationMessage(message) {
  return {
    role: message.role || "user",
    text: message.text,
  };
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
  const roleOptions = ["user", "assistant"]
    .map(
      (role) =>
        `<option value="${role}"${message.role === role ? " selected" : ""}>${role}</option>`,
    )
    .join("");

  return `
    <article class="message${isFinal ? " classified" : ""}" data-message-id="${escapeHtml(message.id)}">
      <div class="message-head">
        <div class="message-title">Message ${index + 1}${
    isFinal ? '<span class="ctx">classified message</span>' : ""
  }</div>
        <div class="message-right">
          <select class="role-pill" data-field="role" aria-label="Role"${isFinal ? " disabled" : ""}>${roleOptions}</select>
          <button
            class="message-close"
            type="button"
            data-remove-message="${escapeHtml(message.id)}"
            aria-label="Remove message"
            title="Remove message"
            ${canRemove ? "" : "disabled"}
          >✕</button>
        </div>
      </div>
      <div class="message-label">Text</div>
      <textarea
        class="message-body"
        data-field="text"
        rows="${isFinal ? 3 : 4}"
        placeholder="${isFinal ? "Latest user message to classify..." : "Earlier message text..."}"
        required
      >${escapeHtml(message.text)}</textarea>
    </article>
  `;
}

function focusLastMessage() {
  const inputs = messageList.querySelectorAll("textarea[data-field='text']");
  inputs[inputs.length - 1]?.focus();
}

function handleStreamEvent(event, data) {
  if (event !== "pipeline_phase") {
    appendEvent(event, data?.name ?? null, data?.error ?? data?.reason ?? null);
  }

  switch (event) {
    case "pipeline_started":
      if (Array.isArray(data.classifiers) && data.classifiers.length > 0) {
        state.classifierNames = data.classifiers;
      }
      state.pipelineStartedAt = performance.now();
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
      state.pipelineCompletedAt = performance.now();
      state.lastResult = data;
      renderPipeline(data);
      break;
    case "pipeline_failed":
      setRunState("failed");
      break;
  }
}

function renderPipeline(result) {
  setRunState(pipelineState(result));

  renderAggregate(result);

  if (result.audit?.meta?.classifiers) {
    for (const name of Object.keys(result.audit.meta.classifiers)) {
      const entry = result.audit.meta.classifiers[name];
      const status = entry.status;
      updateClassifier(name, {
        status: status?.ok === false ? "fallback" : "done",
        result: entry,
        error: status?.ok === false ? status.error : null,
        finishedAt: performance.now(),
      });
    }
  }

  if (result.action !== "route" && result.audit?.fired_by) {
    updateClassifier(result.audit.fired_by, { shortCircuited: true });
    cancelClassifiersExcept([result.audit.fired_by]);
  }
  jsonToggle.hidden = false;
  jsonPanel.textContent = JSON.stringify(buildDisplayResult(result), null, 2);
}

function pipelineState(result) {
  if (result.action === "block") return "block";
  if (result.action === "answer") return "terminal";
  return "complete";
}

function pipelineLatencySeconds() {
  if (state.pipelineStartedAt == null || state.pipelineCompletedAt == null) return null;
  return (state.pipelineCompletedAt - state.pipelineStartedAt) / 1000;
}

function renderAggregate(result) {
  const runStateValue = state.runState ?? "idle";
  const runStateLabel = RUN_STATE_LABELS[runStateValue] ?? runStateValue;

  const model = result ? selectedModel(result) ?? "—" : "—";
  const security = result ? securityDecision(result) ?? "—" : "—";
  const action = result ? result.action ?? "—" : "—";
  const tools = result ? toolsSummary(result) : "—";
  const latency = pipelineLatencySeconds();

  const securityClass =
    security === "allow"
      ? "teal"
      : security === "block"
      ? "red"
      : security === "needs_review"
      ? "amber"
      : "";

  aggregatePanel.dataset.state = runStateValue;
  aggregatePanel.hidden = false;
  aggregatePanel.innerHTML = `
    <div class="final-output-head">
      <h2 class="final-output-title">Final Output</h2>
      <span class="run-state" data-state="${escapeHtml(runStateValue)}">${escapeHtml(runStateLabel)}</span>
    </div>
    <div class="final-output-grid">
      ${foItem("Model", model)}
      ${foItem("Action", action)}
      ${foItem("Tools", tools)}
      ${foItem("Security", security, securityClass)}
      ${foItem("Latency", latency != null ? `${latency.toFixed(1)}s` : "—")}
    </div>
  `;
}

function foItem(k, v, cls = "") {
  return `
    <div class="fo-item">
      <span class="k">${escapeHtml(k)}</span>
      <span class="v${cls ? " " + cls : ""}">${escapeHtml(String(v))}</span>
    </div>
  `;
}

function toolsSummary(result) {
  const tools = result.audit?.meta?.classifiers?.tools;
  if (!tools) return "none";
  const list = tools.tools ?? tools.allowed ?? tools.families;
  if (Array.isArray(list) && list.length > 0) {
    return list.join(", ");
  }
  return "none";
}

function buildDisplayResult(result) {
  return {
    model: selectedModel(result),
    action: result.action,
    security: { decision: securityDecision(result) },
    hash: result.message_id,
    latency_seconds: pipelineLatencySeconds(),
    classifiers: Object.fromEntries(stockClassifierOutputs(result)),
  };
}

function selectedModel(result) {
  return result.downstream?.model_id ?? result.audit?.model_recommendation?.id;
}

function securityDecision(result) {
  return result.audit?.meta?.classifiers?.security?.decision ?? result.audit?.safety?.decision;
}

function stockClassifierOutputs(result) {
  const classifiers = result.audit?.meta?.classifiers;
  if (!classifiers) return [];

  return state.classifierNames
    .filter((name) => classifiers[name])
    .map((name) => [name, classifierDisplayOutput(classifiers[name])]);
}

function classifierDisplayOutput(output) {
  return Object.fromEntries(
    Object.entries(output).filter(([key]) => key !== "version" && key !== "status"),
  );
}

function cancelClassifiersExcept(keptNames) {
  const kept = new Set(keptNames);
  for (const name of state.classifierNames) {
    if (kept.has(name)) continue;
    const item = state.classifiers[name] ?? { status: "pending" };
    state.classifiers[name] = {
      ...item,
      status: "aborted",
      result: null,
      error: null,
      finishedAt: performance.now(),
      shortCircuited: false,
    };
  }
  renderClassifiers();
}

function resetClassifiers(status = "pending") {
  state.classifiers = Object.fromEntries(
    state.classifierNames.map((name) => [
      name,
      {
        status,
        result: null,
        error: null,
        startedAt: null,
        finishedAt: null,
        shortCircuited: false,
      },
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
      shortCircuited: false,
    };
  }
  state.classifiers[name] = { ...state.classifiers[name], ...patch };
  renderClassifiers();
}

function renderClassifiers() {
  // distribute cards across two columns in a stable, deterministic way:
  // odd-indexed go to column 0, even-indexed to column 1
  const col0 = [];
  const col1 = [];
  state.classifierNames.forEach((name, idx) => {
    (idx % 2 === 0 ? col0 : col1).push(renderClassifier(name));
  });
  classifierGrid.innerHTML = `
    <div class="col">${col0.join("")}</div>
    <div class="col">${col1.join("")}</div>
  `;
  updateTickers();
}

function renderClassifier(name) {
  const item = state.classifiers[name] ?? { status: "pending" };
  const metadata = CLASSIFIER_METADATA[name] ?? {};
  const kind = metadata.kind ?? "stock";
  const purpose = metadata.purpose ? escapeHtml(metadata.purpose) : "";
  const accent = kind === "custom" ? " accent" : "";

  const reason = item.result?.reason;
  const confidence = item.result?.confidence;
  const reasonPill =
    reason && (item.status === "done" || item.status === "fallback")
      ? `<span class="pill reason" tabindex="0">Reason<span class="pill-tooltip">${escapeHtml(reason)}</span></span>`
      : "";
  const confidencePill =
    typeof confidence === "number"
      ? `<span class="pill-text confident">${(confidence * 100).toFixed(1)}% confident</span>`
      : "";
  const statusPill = renderStatusPill(item);
  const elapsedHtml = `<span class="pill-text elapsed" data-name="${escapeHtml(name)}">${formatElapsed(item)}</span>`;

  const purposeHelp = purpose
    ? `<span class="help" data-tooltip="${purpose}" tabindex="0">?</span>`
    : "";

  const shortCircuit = item.shortCircuited
    ? `<div class="short-circuit-note">Short-circuited pipeline</div>`
    : "";

  return `
    <article class="card${accent}" data-status="${escapeHtml(item.status)}" data-kind="${escapeHtml(kind)}">
      <div class="card-head">
        <h2 class="card-title">${classifierLabel(name)} ${purposeHelp}</h2>
        <div class="meta">
          ${reasonPill}
          ${statusPill}
          ${elapsedHtml}
        </div>
      </div>
      ${shortCircuit}
      ${renderDetails(name, item)}
      <div class="card-foot">${confidencePill}</div>
    </article>
  `;
}

function renderStatusPill(item) {
  switch (item.status) {
    case "running":
      return `<span class="pill running"><span class="pulse"></span>Running</span>`;
    case "done":
      return `<span class="pill done">Done</span>`;
    case "fallback":
      return `<span class="pill fallback">Fallback</span>`;
    case "failed":
      return `<span class="pill failed">Failed</span>`;
    case "timeout":
      return `<span class="pill timeout">Timed out</span>`;
    case "aborted":
      return `<span class="pill aborted">Aborted</span>`;
    case "idle":
      return `<span class="pill">Idle</span>`;
    case "pending":
    default:
      return `<span class="pill">Pending</span>`;
  }
}

function formatElapsed(item) {
  if (!item.startedAt) return "";
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
    const el = classifierGrid.querySelector(`.elapsed[data-name="${cssEscape(name)}"]`);
    if (el) el.textContent = formatElapsed(item);
  }
}

function renderDetails(name, item) {
  if (item.error) {
    return `<div class="empty-state error">${escapeHtml(item.error)}</div>`;
  }

  const result = item.result;
  if (!result) {
    return `<div class="empty-state">${emptyStateText(item.status)}</div>`;
  }

  return renderClassifierResult(result);
}

function classifierLabel(name) {
  const raw = CLASSIFIER_METADATA[name]?.ui?.label;
  if (raw) return escapeHtml(raw);
  return escapeHtml(
    String(name)
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
  );
}

function emptyStateText(status) {
  if (status === "running") return "Running…";
  if (status === "timeout") return "Timed out";
  if (status === "aborted") return "Aborted by gate";
  if (status === "failed") return "Failed";
  if (status === "pending") return "Queued";
  return "Awaiting run";
}

function renderClassifierResult(result) {
  const entries = Object.entries(result)
    .filter(
      ([key]) => key !== "version" && key !== "status" && key !== "reason" && key !== "confidence",
    )
    .filter(([, value]) => !isEmptyValue(value));
  if (entries.length === 0) {
    return "";
  }

  const rendered = entries.map(([key, value]) => renderResultField(key, value)).join("");
  return rendered;
}

function renderResultField(key, value) {
  if (isEmptyValue(value)) return "";
  if (Array.isArray(value)) {
    return renderListField(key, value);
  }
  if (isPlainObject(value)) {
    return renderObjectField(key, value);
  }
  return `
    <div class="field">
      <span class="field-label">${escapeHtml(formatKeyLabel(key))}</span>
      <span class="field-value">${escapeHtml(formatScalar(value))}</span>
    </div>
  `;
}

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0 || value.every(isEmptyValue);
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return true;
    return entries.every(([, v]) => isEmptyValue(v));
  }
  return false;
}

function renderListField(key, list) {
  const items = list.filter((entry) => !isEmptyValue(entry));
  if (items.length === 0) return "";
  return `
    <div class="list-wrap">
      <div class="list-head">
        <span class="field-label">${escapeHtml(formatKeyLabel(key))}</span>
        <span class="count">${items.length} item${items.length === 1 ? "" : "s"}</span>
      </div>
      ${items
        .map(
          (entry, idx) => `
        <div class="list-item">
          <span class="idx">${idx + 1}</span>
          <span class="val">${escapeHtml(scalarOrInline(entry))}</span>
        </div>
      `,
        )
        .join("")}
    </div>
  `;
}

function renderObjectField(key, obj) {
  const entries = Object.entries(obj).filter(([, value]) => !isEmptyValue(value));
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => renderResultField(`${key}.${k}`, v)).join("");
}

function scalarOrInline(value) {
  if (isPlainObject(value) || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return formatScalar(value);
}

function formatScalar(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatKeyLabel(key) {
  return String(key).replaceAll("_", " ");
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
        : "<span></span>";
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

function resetCopyJsonButton() {
  copyJsonButton.textContent = "Copy";
}

function eventTag(name) {
  if (name.endsWith("_completed") || name === "pipeline_completed") return { kind: "ok" };
  if (name.endsWith("_failed") || name === "error") return { kind: "err" };
  if (name.endsWith("_timed_out") || name.endsWith("_aborted") || name.endsWith("_canceled"))
    return { kind: "warn" };
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

const RUN_STATE_LABELS = {
  idle: "Idle",
  normalizing: "Normalizing",
  resource_check: "Resource check",
  running: "Running",
  complete: "Complete",
  terminal: "Terminal",
  block: "Block",
  failed: "Failed",
};

function setRunState(value) {
  state.runState = value;
  liveDot.dataset.state = value;
  aggregatePanel.dataset.state = value;
  const runStateEl = aggregatePanel.querySelector(".run-state");
  if (runStateEl) {
    runStateEl.textContent = RUN_STATE_LABELS[value] ?? value;
    runStateEl.dataset.state = value;
  } else {
    renderAggregate(state.lastResult);
  }
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
