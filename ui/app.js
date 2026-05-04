const classifierNames = [
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

const state = {
  metadata: null,
  attachments: [],
  classifiers: {},
};

const form = document.querySelector("#classifyForm");
const attachmentInput = document.querySelector("#attachmentInput");
const attachmentList = document.querySelector("#attachmentList");
const classifierGrid = document.querySelector("#classifierGrid");
const runState = document.querySelector("#runState");
const awkValue = document.querySelector("#awkValue");
const pipelineStatus = document.querySelector("#pipelineStatus");
const hashes = document.querySelector("#hashes");
const jsonPanel = document.querySelector("#jsonPanel");
const modelLabel = document.querySelector("#modelLabel");
const clearButton = document.querySelector("#clearButton");

init();

async function init() {
  const response = await fetch("/api/metadata");
  state.metadata = await response.json();
  modelLabel.textContent = `Ollama base model: ${state.metadata.base_model} · ${state.metadata.ollama_required_parallelism}-way · ctx ${state.metadata.ollama_context_length}`;
  resetClassifiers();
  renderAttachments();

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
    resetClassifiers();
    renderAttachments();
    setRunState("Idle");
    awkValue.textContent = "Waiting";
    pipelineStatus.textContent = "Not run";
    hashes.hidden = true;
    jsonPanel.hidden = true;
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void classify();
  });
}

async function classify() {
  resetClassifiers();
  setRunState("Running");
  pipelineStatus.textContent = "Normalizing";
  awkValue.textContent = "Waiting";
  hashes.hidden = true;
  jsonPanel.hidden = true;
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
    setRunState("Failed");
    pipelineStatus.textContent = error.message;
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
  switch (event) {
    case "normalization_started":
      pipelineStatus.textContent = "Normalized input pending";
      break;
    case "resource_check_started":
      pipelineStatus.textContent = `Checking local resources for ${data.required_parallelism}-way runtime · ctx ${data.context_length}`;
      break;
    case "classifier_started":
      updateClassifier(data.name, { status: "running" });
      break;
    case "classifier_completed":
      updateClassifier(data.name, { status: "done", result: data.result });
      if (data.name === "preflight" && data.result?.awk) {
        awkValue.textContent = data.result.awk;
      }
      break;
    case "classifier_canceled":
      updateClassifier(data.name, { status: "canceled" });
      break;
    case "classifier_failed":
      updateClassifier(data.name, { status: "failed", error: data.error });
      break;
    case "pipeline_completed":
      renderPipeline(data);
      break;
    case "pipeline_failed":
      setRunState("Failed");
      pipelineStatus.textContent = data.error;
      break;
  }
}

function renderPipeline(result) {
  setRunState(result.status === "terminal" ? "Terminal" : "Complete");
  pipelineStatus.textContent = result.status;

  if (result.status === "terminal") {
    awkValue.textContent = result.preflight.awk;
  } else {
    awkValue.textContent = result.awk;
  }

  hashes.hidden = false;
  hashes.innerHTML = `
    <div>message_hash ${escapeHtml(result.request.message_hash)}</div>
    <div>request_hash ${escapeHtml(result.request.request_hash)}</div>
  `;

  jsonPanel.hidden = false;
  jsonPanel.textContent = JSON.stringify(result, null, 2);
}

function resetClassifiers() {
  state.classifiers = Object.fromEntries(
    classifierNames.map((name) => [name, { status: "pending", result: null, error: null }]),
  );
  renderClassifiers();
}

function updateClassifier(name, patch) {
  state.classifiers[name] = {
    ...state.classifiers[name],
    ...patch,
  };
  renderClassifiers();
}

function renderClassifiers() {
  classifierGrid.innerHTML = classifierNames.map(renderClassifier).join("");
}

function renderClassifier(name) {
  const item = state.classifiers[name] ?? { status: "pending" };
  const result = item.result;
  const optionHtml = renderOptions(name, result);
  const detailHtml = renderDetails(name, item);

  return `
    <article class="classifier-card">
      <div class="classifier-head">
        <h2 class="classifier-title">${labels[name]}</h2>
        <span class="badge ${item.status}">${item.status}</span>
      </div>
      ${optionHtml}
      ${detailHtml}
    </article>
  `;
}

function renderOptions(name, result) {
  if (name === "security_posture") {
    return `
      <div class="option-row">${renderEnumOptions("security_posture", result?.value)}</div>
      <div class="option-row">${renderEnumOptions("security_signal", result?.signals ?? [])}</div>
    `;
  }

  const key = optionKeys[name];
  if (!key) {
    return "";
  }

  const selected = name === "tool_family_need" ? result?.value ?? [] : result?.value ?? result?.terminality;
  return `<div class="option-row">${renderEnumOptions(key, selected)}</div>`;
}

function renderEnumOptions(key, selected) {
  const selectedValues = new Set(Array.isArray(selected) ? selected : selected ? [selected] : []);
  return (state.metadata?.enums?.[key] ?? [])
    .map((option) => {
      const selectedClass = selectedValues.has(option) ? " selected" : "";
      return `<span class="option${selectedClass}">${option}</span>`;
    })
    .join("");
}

function renderDetails(name, item) {
  if (item.error) {
    return `<div class="summary">${escapeHtml(item.error)}</div>`;
  }

  const result = item.result;
  if (!result) {
    return `<div class="summary">${emptyStateText(item.status)}</div>`;
  }

  if (name === "preflight") {
    return `<div class="summary">${escapeHtml(result.awk)}</div>`;
  }

  if (name === "memory_retrieval_queries") {
    const queries = result.queries?.length ? result.queries : ["No queries"];
    return `<div class="query-row">${queries.map((query) => `<span class="option selected">${escapeHtml(query)}</span>`).join("")}</div>`;
  }

  if (name === "message_and_attachment_digest") {
    return `
      <div class="summary"><strong>${escapeHtml(result.slug)}</strong></div>
      <div class="summary">${escapeHtml(result.summary)}</div>
    `;
  }

  if (name === "security_posture") {
    return `<div class="summary">${escapeHtml(result.notes)}</div>`;
  }

  return "";
}

function emptyStateText(status) {
  if (status === "running") {
    return "Running";
  }
  if (status === "canceled") {
    return "Canceled by preflight";
  }
  return "Pending";
}

function renderAttachments() {
  if (state.attachments.length === 0) {
    attachmentList.innerHTML = "";
    return;
  }

  attachmentList.innerHTML = state.attachments
    .map(
      (attachment) => `
        <div class="attachment">
          <div>
            <strong>${escapeHtml(attachment.filename)}</strong>
            <span>${formatBytes(attachment.size_bytes)} ${escapeHtml(attachment.mime_type || "unknown type")}</span>
          </div>
        </div>
      `,
    )
    .join("");
}

async function readEventStream(stream, onEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const parsed = parseSseEvent(part);
      if (parsed) {
        onEvent(parsed.event, parsed.data);
      }
    }
  }
}

function parseSseEvent(chunk) {
  const lines = chunk.split("\n");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (!eventLine || !dataLine) {
    return null;
  }

  return {
    event: eventLine.slice(7),
    data: JSON.parse(dataLine.slice(6)),
  };
}

function setRunState(value) {
  runState.textContent = value;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) {
    return "0 B";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
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
