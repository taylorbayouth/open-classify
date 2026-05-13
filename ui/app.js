let CLASSIFIER_METADATA = {};

const state = {
  messages: [createMessage()],
  samples: [],
  classifierNames: [],
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
const classifierGrid = document.querySelector("#classifierGrid");
const aggregatePanel = document.querySelector("#aggregatePanel");
const runState = document.querySelector("#runState");
const liveDot = document.querySelector("#liveDot");
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
  renderEventLog();
  resetClassifiers("idle");
  setRunState("idle");
  aggregatePanel.hidden = true;
  aggregatePanel.innerHTML = "";
  jsonToggle.hidden = true;
  jsonToggle.removeAttribute("open");
  resetCopyJsonButton();
}

async function classify() {
  resetClassifiers();
  state.events = [];
  state.eventCount = 0;
  renderEventLog();
  setRunState("running");
  aggregatePanel.hidden = true;
  aggregatePanel.innerHTML = "";
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
        <div class="message-editor-title">
          <strong>Message ${index + 1}</strong>
          <span>${isFinal ? "classified message" : "context"}</span>
        </div>
        <label class="message-role-select">
          <select data-field="role" aria-label="Role"${isFinal ? " disabled" : ""}>
            ${["user", "assistant"]
              .map((role) => `<option value="${role}"${message.role === role ? " selected" : ""}>${role}</option>`)
              .join("")}
          </select>
        </label>
        <button class="icon-button" type="button" data-remove-message="${escapeHtml(message.id)}" title="Remove message" aria-label="Remove message"${canRemove ? "" : " disabled"}>×</button>
      </div>
      <label class="field">
        <span>Text</span>
        <textarea data-field="text" rows="2" placeholder="${isFinal ? "Latest user message to classify..." : "Earlier message text..."}" required>${escapeHtml(message.text)}</textarea>
      </label>
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

function renderAggregate(result) {
  aggregatePanel.hidden = false;
  aggregatePanel.innerHTML = `
    <span class="result-banner-label">Final output</span>
    ${resultBannerItem("Model", selectedModel(result))}
    ${resultToolsItem(selectedTools(result))}
    ${resultBannerItem(classifierLabelText("security"), securityDecision(result))}
  `;
}

function buildDisplayResult(result) {
  return {
    model: selectedModel(result),
    action: result.action,
    security: {
      decision: securityDecision(result),
    },
    hash: result.message_id,
    classifiers: Object.fromEntries(stockClassifierOutputs(result)),
  };
}

function selectedModel(result) {
  return result.downstream?.model_id ?? result.audit?.model_recommendation?.id;
}

function securityDecision(result) {
  return result.audit?.meta?.classifiers?.security?.decision ?? result.audit?.safety?.decision;
}

function selectedTools(result) {
  return result.downstream?.tools?.tools ?? result.audit?.tools?.tools ?? [];
}

function stockClassifierOutputs(result) {
  const classifiers = result.audit?.meta?.classifiers;
  if (!classifiers) return [];

  return state.classifierNames
    .filter((name) => CLASSIFIER_METADATA[name]?.kind === "stock" && classifiers[name])
    .map((name) => [name, classifierDisplayOutput(classifiers[name])]);
}

function classifierDisplayOutput(output) {
  return Object.fromEntries(
    Object.entries(output).filter(([key]) => key !== "version" && key !== "status"),
  );
}

function resultBannerItem(label, value) {
  if (value === undefined || value === "") return "";
  return `
    <div class="result-banner-item">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
    </div>
  `;
}

function resultToolsItem(tools) {
  const items = Array.isArray(tools) && tools.length > 0 ? tools : ["none"];
  return `
    <div class="result-banner-item result-tools-item">
      <span>${escapeHtml(classifierLabelText("tools"))}</span>
      <div class="pill-list">
        ${items.map((tool) => `<strong class="tool-pill${tool === "none" ? " is-empty" : ""}">${escapeHtml(String(tool))}</strong>`).join("")}
      </div>
    </div>
  `;
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
  classifierGrid.innerHTML = state.classifierNames.map(renderClassifier).join("");
  updateTickers();
}

function renderClassifier(name) {
  const item = state.classifiers[name] ?? { status: "pending" };
  const result = item.result;
  const detailHtml = renderDetails(name, item);
  const elapsedHtml = `<span class="elapsed" data-name="${name}">${formatElapsed(item)}</span>`;
  const confidenceHtml = renderClassifierConfidence(item);
  const metadata = CLASSIFIER_METADATA[name] ?? {};
  const kind = metadata.kind ?? "classifier";
  const purpose = metadata.purpose ? escapeHtml(metadata.purpose) : "";
  const purposeHtml = purpose
    ? `
        <div class="classifier-purpose">
          <button
            class="purpose-trigger"
            type="button"
            aria-label="Show classifier purpose for ${classifierLabel(name)}"
          >?</button>
          <span class="purpose-tooltip" role="tooltip">${purpose}</span>
        </div>
      `
    : "";
  const reasonHtml = renderReasonPill(result);
  const shortCircuitHtml = item.shortCircuited
    ? `<div class="short-circuit-note">Short-circuited pipeline</div>`
    : "";

  return `
    <article class="classifier-card" data-status="${item.status}" data-kind="${escapeHtml(kind)}">
      <div class="classifier-head">
        <div class="title-block">
          <div class="classifier-title-row">
            <h2 class="classifier-title">${classifierLabel(name)}</h2>
            ${purposeHtml}
          </div>
        </div>
        <div class="status-block">
          ${reasonHtml}
          <span class="badge ${item.status}">
            ${item.status === "running" ? '<span class="pulse"></span>' : ""}${escapeHtml(classifierStatusLabel(item))}
          </span>
          ${confidenceHtml}
          ${elapsedHtml}
        </div>
      </div>
      ${shortCircuitHtml}
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

function renderDetails(name, item) {
  if (item.error) {
    return `<div class="detail error">${escapeHtml(item.error)}</div>`;
  }

  const result = item.result;
  if (!result) {
    return `<div class="detail muted">${emptyStateText(item.status)}</div>`;
  }

  return renderClassifierResult(name, result);
}

function classifierLabel(name) {
  return escapeHtml(classifierLabelText(name));
}

function classifierLabelText(name) {
  return toTitleCaseLabel(name);
}

function emptyStateText(status) {
  if (status === "running") return "Running…";
  if (status === "timeout") return "Timed out; retrying";
  if (status === "aborted") return "Aborted by gate";
  if (status === "failed") return "Failed";
  if (status === "pending") return "Queued";
  return "Awaiting run";
}

function objectRow(key, value) {
  return `
    <div class="object-row">
      <span class="object-key">${escapeHtml(key)}</span>
      ${renderValue(value, key)}
    </div>
  `;
}

function renderValue(value, key = "") {
  if (Array.isArray(value)) {
    if (value.length === 0) return `<code class="object-scalar">[]</code>`;
    return `
      <div class="object-list">
        ${value.map((item, index) => `
          <div class="object-list-item">
            <span class="object-index">${index + 1}</span>
            ${renderValue(item)}
          </div>
        `).join("")}
      </div>
    `;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `<code class="object-scalar">{}</code>`;
    const content = `<div class="object-nested">${entries.map(([itemKey, item]) => objectRow(itemKey, item)).join("")}</div>`;
    if (key === "status" || entries.length > 2) {
      return `
        <div class="object-details nested-details">
          <div class="object-details-head">${escapeHtml(objectSummary(value))}</div>
          ${content}
        </div>
      `;
    }
    return content;
  }

  return `<code class="object-scalar">${escapeHtml(formatScalar(value))}</code>`;
}

function formatScalar(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderClassifierResult(name, result) {
  const entries = Object.entries(filterClassifierResult(name, result))
    .filter(([key, value]) => key !== "version" && key !== "status" && hasRenderableValue(value));
  const flattenedEntries = entries.map(([key, value]) => [key, flattenSingleScalarObject(pruneEmptyArrays(value))]);
  const primary = flattenedEntries.filter(([, value]) => !isExpandableValue(value));
  const nested = flattenedEntries.filter(([, value]) => isExpandableValue(value));

  const HIDDEN_KEYS = new Set(["confidence"]);
  const visiblePrimary = primary.filter(([key]) => !HIDDEN_KEYS.has(key));
  const mainPrimary = visiblePrimary.filter(([key]) => key !== "reason");

  return `
    ${mainPrimary.length === 0 ? "" : `
      <div class="field-list">
        ${mainPrimary.map(([key, value]) => fieldRow(key, value)).join("")}
      </div>
    `}
    ${nested.length === 0 ? "" : `
      <div class="detail-stack">
        ${nested.map(([key, value]) => `
          <div class="object-details classifier-detail">
            <div class="object-details-head"><span>${escapeHtml(formatKeyLabel(key))}</span><strong>${escapeHtml(objectSummary(value))}</strong></div>
            <div class="object-grid classifier-output">${renderClassifierDetailBody(value)}</div>
          </div>
        `).join("")}
      </div>
    `}
  `;
}

function renderReasonPill(result) {
  const reason = typeof result?.reason === "string" ? result.reason.trim() : "";
  if (!reason) {
    return "";
  }

  return `
    <div class="reason-pill-wrap">
      <span class="reason-pill" tabindex="0">Reason<span class="reason-pill-dot" aria-hidden="true">•</span></span>
      <span class="reason-tooltip" role="tooltip">${escapeHtml(reason)}</span>
    </div>
  `;
}

function classifierStatusLabel(item) {
  return {
    pending: "Pending",
    running: "Running",
    done: "Done",
    fallback: "Fallback",
    timeout: "Timeout",
    aborted: "Aborted",
    failed: "Failed",
    idle: "Idle",
  }[item.status] ?? formatKeyLabel(item.status);
}

function renderClassifierConfidence(item) {
  const confidence = item.result?.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return "";
  }

  return `<span class="confidence-readout">${escapeHtml(`${(confidence * 100).toFixed(1)}% confident`)}</span>`;
}

function filterClassifierResult(name, result) {
  if (name === "routing") {
    const { specialization, ...rest } = result;
    void specialization;
    return rest;
  }
  if (name === "model_specialization") {
    const { model_tier, ...rest } = result;
    void model_tier;
    return rest;
  }
  return result;
}

function renderClassifierDetailBody(value) {
  if (Array.isArray(value)) {
    return renderValue(value);
  }

  if (!isPlainObject(value)) {
    return `<div class="object-body-scalar"><code class="object-scalar">${escapeHtml(formatScalar(value))}</code></div>`;
  }

  const entries = Object.entries(value).filter(([, item]) => hasRenderableValue(item));
  if (entries.length === 0) {
    return `<div class="object-body-scalar"><code class="object-scalar">{}</code></div>`;
  }

  return entries.map(([itemKey, item]) => objectRow(itemKey, item)).join("");
}

function fieldRow(key, value) {
  return `
    <div class="field-row">
      <span>${escapeHtml(formatKeyLabel(key))}</span>
      <strong>${escapeHtml(formatScalar(value))}</strong>
    </div>
  `;
}

function isExpandableValue(value) {
  return Array.isArray(value) || isPlainObject(value);
}

function hasRenderableValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.values(value).some(hasRenderableValue);
  return true;
}

function pruneEmptyArrays(value) {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => hasRenderableValue(item))
      .map(([key, item]) => [key, pruneEmptyArrays(item)]),
  );
}

function flattenSingleScalarObject(value) {
  if (!isPlainObject(value)) return value;
  const entries = Object.entries(value);
  if (entries.length !== 1) return value;
  const [, child] = entries[0];
  return isExpandableValue(child) ? value : child;
}

function formatKeyLabel(key) {
  return String(key).replaceAll("_", " ");
}

function toTitleCaseLabel(value) {
  return formatKeyLabel(value)
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function objectSummary(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (!isPlainObject(value)) return formatScalar(value);
  if ("ok" in value && "source" in value) {
    return `${value.ok ? "ok" : "not ok"} · ${value.source}`;
  }
  if ("kind" in value) return String(value.kind);
  if ("status" in value) return String(value.status);
  return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
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

function resetCopyJsonButton() {
  copyJsonButton.textContent = "Copy";
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
