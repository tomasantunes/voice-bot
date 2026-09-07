const $ = (selector) => document.querySelector(selector);
const state = { pc: null, dc: null, stream: null, meetingId: null, settings: null, userText: new Map(), assistantText: new Map(), lastLanguage: null, started: false };
const ui = {
  loginView: $("#loginView"), appView: $("#appView"), loginForm: $("#loginForm"), loginError: $("#loginError"),
  settingsForm: $("#settingsForm"), voice: $("#voiceSelect"), mode: $("#modeSelect"), start: $("#startButton"), end: $("#endButton"),
  transcript: $("#transcript"), status: $("#statusText"), dot: $("#statusDot"), orb: $("#orb"), activeMode: $("#activeMode"),
  remoteAudio: $("#remoteAudio"), saveState: $("#saveState"), history: $("#historyList"), toast: new bootstrap.Toast($("#toast"))
};

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return { body, response };
}

function showToast(message) { $("#toastBody").textContent = message; ui.toast.show(); }
function titleCase(value) { return value.replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()); }
function setStatus(text, activity = "") {
  ui.status.textContent = text; ui.dot.classList.toggle("live", Boolean(activity));
  ui.orb.className = `voice-orb${activity ? ` live ${activity}` : ""}`;
}

function responseLanguage(transcript) {
  const words = transcript.toLocaleLowerCase().match(/[\p{L}']+/gu) || [];
  const vocabulary = {
    "English": ["hello", "hi", "hey", "how", "are", "you", "what", "where", "when", "why", "can", "could", "would", "please", "thanks", "thank", "the", "and", "is", "do"],
    "European Portuguese": ["olá", "ola", "como", "estás", "estas", "está", "esta", "tudo", "bem", "falar", "falas", "português", "portugues", "obrigado", "obrigada", "que", "não", "nao", "sim", "uma", "para", "com"],
    "French": ["bonjour", "salut", "comment", "allez", "vous", "merci", "français", "oui", "avec", "pour", "une"],
    "Spanish": ["hola", "cómo", "como", "estás", "estas", "gracias", "español", "qué", "que", "para", "una"]
  };
  const scores = Object.fromEntries(Object.entries(vocabulary).map(([language, terms]) => [language, words.reduce((score, word) => score + Number(terms.includes(word)), 0)]));
  if (/[ãõç]/i.test(transcript)) scores["European Portuguese"] += 3;
  const [language, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (score > 0) state.lastLanguage = language;
  return score > 0 ? language : (state.lastLanguage || "exactly the language used in the latest user transcript");
}

function requestResponse(transcript) {
  if (state.dc?.readyState !== "open") return;
  const language = responseLanguage(transcript);
  state.dc.send(JSON.stringify({
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: `Reply only in ${language}. Do not answer in another language unless the user explicitly asked you to translate or switch languages.`
    }
  }));
}

async function bootstrapApp() {
  try {
    const { body } = await api("/api/bootstrap");
    ui.loginView.classList.toggle("d-none", body.authenticated);
    ui.appView.classList.toggle("d-none", !body.authenticated);
    if (!body.authenticated) return;
    state.settings = body.settings;
    ui.voice.replaceChildren(...body.voices.map((voice) => new Option(titleCase(voice), voice)));
    ui.mode.replaceChildren(...body.modes.map((mode) => new Option(titleCase(mode), mode)));
    ui.voice.value = state.settings.voice; ui.mode.value = state.settings.mode;
    ui.activeMode.textContent = titleCase(state.settings.mode);
  } catch (error) { showToast(error.message); }
}

ui.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault(); ui.loginError.classList.add("d-none");
  const loginForm = event.currentTarget;
  const form = new FormData(loginForm);
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
    loginForm.reset(); await bootstrapApp();
  } catch (error) { ui.loginError.textContent = error.message; ui.loginError.classList.remove("d-none"); }
});

ui.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ voice: ui.voice.value, mode: ui.mode.value }) });
    state.settings = { voice: ui.voice.value, mode: ui.mode.value }; ui.activeMode.textContent = titleCase(ui.mode.value);
    bootstrap.Offcanvas.getInstance($("#settingsPanel"))?.hide(); showToast("Preferences saved");
  } catch (error) { showToast(error.message); }
});

function addMessage(role, text, id, pending = false) {
  $(".empty-state")?.remove();
  let item = document.getElementById(`msg-${CSS.escape(id)}`);
  if (!item) {
    item = document.createElement("div"); item.id = `msg-${id}`; item.className = `message ${role}`;
    const label = document.createElement("div"); label.className = "message-role"; label.textContent = role === "user" ? "You" : "Partner";
    const content = document.createElement("div"); content.className = "message-text";
    item.append(label, content); ui.transcript.append(item);
  }
  item.classList.toggle("pending", pending); item.querySelector(".message-text").textContent = text;
  ui.transcript.scrollTop = ui.transcript.scrollHeight;
}

async function persist(role, content, eventId) {
  if (!state.meetingId || !content.trim()) return;
  ui.saveState.textContent = "Saving…";
  try {
    await api(`/api/meetings/${state.meetingId}/messages`, { method: "POST", body: JSON.stringify({ role, content, eventId }) });
    ui.saveState.textContent = "Saved automatically";
  } catch (error) { ui.saveState.textContent = "Save failed"; showToast(error.message); }
}

function handleRealtime(event) {
  const type = event.type || "";
  if (type === "input_audio_buffer.speech_started") setStatus("Listening…", "listening");
  if (type === "input_audio_buffer.speech_stopped") setStatus("Thinking…", "live");
  if (type === "conversation.item.input_audio_transcription.delta") {
    const next = (state.userText.get(event.item_id) || "") + (event.delta || ""); state.userText.set(event.item_id, next); addMessage("user", next, event.item_id, true);
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = event.transcript || state.userText.get(event.item_id) || ""; addMessage("user", text, event.item_id); persist("user", text, event.item_id); state.userText.delete(event.item_id); requestResponse(text);
  }
  if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
    const id = event.item_id || event.response_id || "assistant-live";
    const next = (state.assistantText.get(id) || "") + (event.delta || ""); state.assistantText.set(id, next); addMessage("assistant", next, id, true); setStatus("Speaking…", "speaking");
  }
  if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
    const id = event.item_id || event.response_id || "assistant-live";
    const text = event.transcript || state.assistantText.get(id) || ""; addMessage("assistant", text, id); persist("assistant", text, id); state.assistantText.delete(id);
  }
  if (type === "response.done") setStatus("Listening…", "listening");
  if (type === "error") { console.error(event); showToast(event.error?.message || "Realtime connection error"); }
}

async function startMeeting() {
  if (state.started) return;
  ui.start.disabled = true; setStatus("Connecting…", "live");
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    state.pc = new RTCPeerConnection(); state.pc.ontrack = ({ streams }) => { ui.remoteAudio.srcObject = streams[0]; };
    state.stream.getTracks().forEach((track) => state.pc.addTrack(track, state.stream));
    state.dc = state.pc.createDataChannel("oai-events");
    state.dc.addEventListener("message", ({ data }) => { try { handleRealtime(JSON.parse(data)); } catch (error) { console.error(error); } });
    state.dc.addEventListener("open", () => setStatus("Listening…", "listening"));
    state.pc.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected"].includes(state.pc?.connectionState)) { showToast("Voice connection lost"); endMeeting(); }
    });
    const offer = await state.pc.createOffer(); await state.pc.setLocalDescription(offer);
    const { body, response } = await api("/api/realtime", { method: "POST", body: JSON.stringify({ sdp: offer.sdp, ...state.settings }) });
    state.meetingId = Number(response.headers.get("x-meeting-id"));
    await state.pc.setRemoteDescription({ type: "answer", sdp: body });
    state.started = true; ui.start.classList.add("d-none"); ui.end.classList.remove("d-none"); ui.voice.disabled = true; ui.mode.disabled = true;
    $("#headline").textContent = "I’m listening."; $("#subhead").textContent = "Speak naturally. Pause when you’re done, or interrupt whenever you want.";
  } catch (error) { await closeMedia(); setStatus("Couldn’t connect"); showToast(error.message); }
  finally { ui.start.disabled = false; }
}

async function closeMedia() {
  state.dc?.close(); state.pc?.close(); state.stream?.getTracks().forEach((track) => track.stop()); ui.remoteAudio.srcObject = null;
  state.dc = state.pc = state.stream = null;
}

async function endMeeting() {
  const id = state.meetingId; state.started = false; state.meetingId = null; state.lastLanguage = null; await closeMedia();
  if (id) api(`/api/meetings/${id}/end`, { method: "POST", body: "{}" }).catch(console.error);
  ui.start.classList.remove("d-none"); ui.end.classList.add("d-none"); ui.voice.disabled = false; ui.mode.disabled = false;
  setStatus("Meeting ended"); $("#headline").textContent = "Whenever you’re ready."; $("#subhead").textContent = "Start another meeting or revisit a past conversation.";
}

ui.start.addEventListener("click", startMeeting); ui.end.addEventListener("click", endMeeting);
$("#logoutButton").addEventListener("click", async () => { await endMeeting(); await api("/api/logout", { method: "POST", body: "{}" }); location.reload(); });
$("#historyButton").addEventListener("click", async () => {
  try {
    const { body } = await api("/api/meetings");
    ui.history.replaceChildren(...(body.length ? body.map((meeting) => {
      const button = document.createElement("button"); button.className = "history-item"; button.type = "button";
      const name = document.createElement("span"); name.className = "history-name"; name.textContent = meeting.mode;
      const meta = document.createElement("span"); meta.className = "history-meta"; meta.textContent = `${new Date(meeting.started_at).toLocaleString()} · ${meeting.voice}`;
      button.append(name, meta); button.addEventListener("click", () => loadMeeting(meeting.id)); return button;
    }) : [Object.assign(document.createElement("p"), { className: "text-secondary", textContent: "No meetings yet." })]));
  } catch (error) { showToast(error.message); }
});

async function loadMeeting(id) {
  try {
    const { body } = await api(`/api/meetings/${id}/messages`); ui.transcript.replaceChildren();
    body.forEach((message) => addMessage(message.role, message.content, `history-${message.id}`));
    if (!body.length) ui.transcript.innerHTML = '<div class="empty-state">No transcript was captured for this meeting.</div>';
    bootstrap.Offcanvas.getInstance($("#historyPanel"))?.hide();
  } catch (error) { showToast(error.message); }
}

window.addEventListener("beforeunload", () => { if (state.meetingId) navigator.sendBeacon(`/api/meetings/${state.meetingId}/end`, new Blob(["{}"], { type: "application/json" })); });
bootstrapApp();
