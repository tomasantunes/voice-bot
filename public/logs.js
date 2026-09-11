const list = document.querySelector("#logsList");
const summary = document.querySelector("#logsSummary");
const pagination = document.querySelector("#pagination");

async function api(url) {
  const response = await fetch(url, { credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.replace("/");
    throw new Error("Authentication required");
  }
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function formatDuration(startedAt, endedAt) {
  if (!endedAt) return "In progress";
  const seconds = Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function makeMessage(message) {
  const row = document.createElement("div");
  row.className = `message ${message.role}`;
  const role = document.createElement("div");
  role.className = "message-role";
  role.textContent = message.role === "user" ? "You" : "Partner";
  const content = document.createElement("div");
  content.className = "message-text";
  content.textContent = message.content;
  row.append(role, content);
  return row;
}

function makeLog(meeting) {
  const article = document.createElement("article");
  article.className = "log-card";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "log-card-toggle";
  button.setAttribute("aria-expanded", "false");
  const title = document.createElement("span");
  title.className = "log-card-title";
  title.textContent = meeting.mode;
  const meta = document.createElement("span");
  meta.className = "log-card-meta";
  meta.textContent = `${new Date(meeting.started_at).toLocaleString()} · ${meeting.voice} · ${meeting.message_count} messages · ${formatDuration(meeting.started_at, meeting.ended_at)}`;
  const icon = document.createElement("span");
  icon.className = "log-card-icon";
  icon.textContent = "+";
  button.append(title, meta, icon);
  const transcript = document.createElement("div");
  transcript.className = "log-transcript d-none";
  article.append(button, transcript);

  let loaded = false;
  button.addEventListener("click", async () => {
    const opening = transcript.classList.contains("d-none");
    transcript.classList.toggle("d-none", !opening);
    button.setAttribute("aria-expanded", String(opening));
    icon.textContent = opening ? "−" : "+";
    if (!opening || loaded) return;
    transcript.textContent = "Loading transcript…";
    try {
      const messages = await api(`/api/meetings/${meeting.id}/messages`);
      transcript.replaceChildren(...(messages.length ? messages.map(makeMessage) : [Object.assign(document.createElement("p"), { className: "empty-state mb-0", textContent: "No transcript was captured for this meeting." })]));
      loaded = true;
    } catch (error) { transcript.textContent = error.message; }
  });
  return article;
}

function renderPagination(current, total) {
  pagination.replaceChildren();
  if (total <= 1) return;
  const pages = new Set([1, total, current - 1, current, current + 1]);
  let previous = 0;
  [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b).forEach((page) => {
    if (previous && page > previous + 1) pagination.append(Object.assign(document.createElement("span"), { className: "pagination-gap", textContent: "…" }));
    const link = document.createElement("a");
    link.href = `?page=${page}`;
    link.className = `page-link-button${page === current ? " active" : ""}`;
    link.textContent = page;
    if (page === current) link.setAttribute("aria-current", "page");
    pagination.append(link);
    previous = page;
  });
}

async function loadLogs() {
  const requestedPage = Number(new URLSearchParams(location.search).get("page") || 1);
  try {
    const data = await api(`/api/chat-logs?page=${Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1}`);
    if (data.totalPages && data.page > data.totalPages) return location.replace(`/logs.html?page=${data.totalPages}`);
    summary.textContent = `${data.totalItems} conversation${data.totalItems === 1 ? "" : "s"} saved`;
    list.replaceChildren(...(data.items.length ? data.items.map(makeLog) : [Object.assign(document.createElement("div"), { className: "empty-state log-empty", textContent: "No conversations have been saved yet." })]));
    renderPagination(data.page, data.totalPages);
  } catch (error) {
    summary.textContent = "Could not load conversations";
    list.textContent = error.message;
  }
}

loadLogs();
