const $ = (selector) => document.querySelector(selector);
const VOICE_PROFILE_KEY = "one-on-one-voice-profile";
const state = { pc: null, dc: null, stream: null, meetingId: null, settings: null, userText: new Map(), assistantText: new Map(), lastLanguage: "US English", started: false, voiceProfile: null, voiceProfileEnabled: false, audioContext: null, analyser: null, analyserTimer: null, capturingVoice: false, voiceFrames: [], pendingVoiceMatch: true, assistantSpeaking: false, sawOutputBufferEvent: false, microphoneFallbackTimer: null };
const ui = {
  loginView: $("#loginView"), appView: $("#appView"), loginForm: $("#loginForm"), loginError: $("#loginError"),
  settingsForm: $("#settingsForm"), voice: $("#voiceSelect"), mode: $("#modeSelect"), start: $("#startButton"), end: $("#endButton"),
  transcript: $("#transcript"), status: $("#statusText"), dot: $("#statusDot"), orb: $("#orb"), activeMode: $("#activeMode"),
  remoteAudio: $("#remoteAudio"), saveState: $("#saveState"), history: $("#historyList"), toast: new bootstrap.Toast($("#toast")),
  voiceProfileEnabled: $("#voiceProfileEnabled"), enrollVoice: $("#enrollVoiceButton"), removeVoice: $("#removeVoiceButton"), voiceProfileStatus: $("#voiceProfileStatus")
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

function setAssistantSpeaking(speaking) {
  state.assistantSpeaking = speaking;
  state.stream?.getAudioTracks().forEach((track) => { track.enabled = !speaking; });
  if (speaking) {
    state.capturingVoice = false;
    state.voiceFrames = [];
    setStatus("Speaking… · microphone paused", "speaking");
  } else if (state.started) {
    setStatus("Listening…", "listening");
  }
}

function loadVoiceProfile() {
  try { state.voiceProfile = JSON.parse(localStorage.getItem(VOICE_PROFILE_KEY)); } catch { state.voiceProfile = null; }
  state.voiceProfileEnabled = localStorage.getItem(`${VOICE_PROFILE_KEY}-enabled`) === "true" && Boolean(state.voiceProfile);
  updateVoiceProfileUi();
}

function updateVoiceProfileUi(message = "") {
  const saved = Boolean(state.voiceProfile);
  ui.voiceProfileEnabled.checked = state.voiceProfileEnabled;
  ui.voiceProfileEnabled.disabled = !saved || state.started;
  ui.enrollVoice.disabled = state.started;
  ui.enrollVoice.textContent = saved ? "Update voice profile" : "Create voice profile";
  ui.removeVoice.classList.toggle("d-none", !saved);
  ui.removeVoice.disabled = state.started;
  ui.voiceProfileStatus.textContent = message || (saved ? "Voice profile saved on this device." : "No voice profile saved.");
}

function startVoiceAnalysis(stream) {
  stopVoiceAnalysis();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  state.audioContext = new AudioContextClass();
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 1024;
  state.analyser.smoothingTimeConstant = 0.25;
  state.audioContext.createMediaStreamSource(stream).connect(state.analyser);
  state.analyserTimer = window.setInterval(() => {
    if (!state.capturingVoice || !state.analyser) return;
    const bins = new Uint8Array(state.analyser.frequencyBinCount);
    state.analyser.getByteFrequencyData(bins);
    const energy = bins.reduce((sum, value) => sum + value, 0) / bins.length;
    if (energy > 8) state.voiceFrames.push(bins);
  }, 60);
}

function stopVoiceAnalysis() {
  if (state.analyserTimer) window.clearInterval(state.analyserTimer);
  state.audioContext?.close().catch(() => {});
  state.audioContext = state.analyser = state.analyserTimer = null;
  state.capturingVoice = false;
  state.voiceFrames = [];
}

function voiceSignature(frames) {
  if (frames.length < 8) return null;
  const groups = 24;
  const signature = Array(groups).fill(0);
  for (const frame of frames) {
    const usableBins = Math.min(frame.length, 256);
    for (let group = 0; group < groups; group += 1) {
      const start = Math.floor(group * usableBins / groups);
      const end = Math.floor((group + 1) * usableBins / groups);
      let total = 0;
      for (let index = start; index < end; index += 1) total += frame[index];
      signature[group] += Math.log1p(total / Math.max(1, end - start));
    }
  }
  const mean = signature.reduce((sum, value) => sum + value, 0) / groups;
  const centered = signature.map((value) => value / frames.length - mean / frames.length);
  const magnitude = Math.hypot(...centered);
  return magnitude ? centered.map((value) => value / magnitude) : null;
}

function voiceMatchesProfile(frames) {
  if (!state.voiceProfileEnabled || !state.voiceProfile) return true;
  const signature = voiceSignature(frames);
  if (!signature) return false;
  const similarity = signature.reduce((sum, value, index) => sum + value * state.voiceProfile.signature[index], 0);
  return similarity >= 0.9;
}

async function enrollVoiceProfile() {
  ui.enrollVoice.disabled = true;
  ui.voiceProfileStatus.textContent = "Speak naturally for 6 seconds…";
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(), video: false });
    startVoiceAnalysis(stream); state.voiceFrames = []; state.capturingVoice = true;
    await new Promise((resolve) => window.setTimeout(resolve, 6000));
    state.capturingVoice = false;
    const signature = voiceSignature(state.voiceFrames);
    if (!signature) throw new Error("Not enough speech was detected. Please try again and speak continuously.");
    state.voiceProfile = { version: 1, signature, createdAt: new Date().toISOString() };
    state.voiceProfileEnabled = true;
    localStorage.setItem(VOICE_PROFILE_KEY, JSON.stringify(state.voiceProfile));
    localStorage.setItem(`${VOICE_PROFILE_KEY}-enabled`, "true");
    updateVoiceProfileUi("Voice profile saved. Filtering is enabled.");
  } catch (error) { updateVoiceProfileUi(error.message); }
  finally { stopVoiceAnalysis(); stream?.getTracks().forEach((track) => track.stop()); ui.enrollVoice.disabled = state.started; }
}

function responseLanguage(transcript) {
  const words = transcript.toLocaleLowerCase().match(/[\p{L}']+/gu) || [];
  const english = new Set(["hello", "hi", "hey", "how", "are", "you", "your", "what", "where", "when", "why", "who", "can", "could", "would", "please", "thanks", "thank", "the", "and", "is", "do", "does", "did", "i", "i'm", "we", "it", "this", "that", "with", "for", "yes", "okay", "right"]);
  const portuguese = new Set(["olá", "ola", "bom", "boa", "como", "estás", "estas", "está", "esta", "estou", "tudo", "bem", "falar", "falas", "português", "portugues", "obrigado", "obrigada", "quê", "que", "não", "nao", "sim", "uma", "para", "com", "eu", "tu", "ele", "ela", "nós", "nos", "isto", "isso", "hoje", "ontem", "amanhã", "amanha", "quero", "podes", "pode"]);
  let englishScore = words.reduce((score, word) => score + Number(english.has(word)), 0);
  let portugueseScore = words.reduce((score, word) => score + Number(portuguese.has(word)), 0);
  if (/[ãõçáàâéêíóôú]/i.test(transcript)) portugueseScore += 3;
  if (/(?:ção|ções|mente|nh[ao]|lh[ao])\b/i.test(transcript)) portugueseScore += 2;
  if (/\b(?:the|this|that|what|how|why|would|could|should)\b/i.test(transcript)) englishScore += 2;
  if (portugueseScore > englishScore) state.lastLanguage = "European Portuguese";
  if (englishScore > portugueseScore) state.lastLanguage = "US English";
  return state.lastLanguage;
}

function requestResponse(transcript) {
  if (state.dc?.readyState !== "open") return;
  const language = responseLanguage(transcript);
  const languageRule = language === "European Portuguese"
    ? 'Reply only in native European Portuguese (pt-PT), using Portugal pronunciation, vocabulary, grammar, and forms of address. Never use Brazilian Portuguese. Use "tu" naturally rather than "você".'
    : "Reply only in natural US English, using American vocabulary, spelling, and pronunciation.";
  state.dc.send(JSON.stringify({
    type: "response.create",
    response: {
      output_modalities: ["audio"],
      instructions: `The user's newest complete utterance is: ${JSON.stringify(transcript)}. Answer that utterance directly and prioritize it over the previous subject. If it introduces a new question or topic, switch to it immediately. Use earlier turns only when the newest utterance clearly refers back to them. Do not repeat or continue your previous answer unless the user asked you to. ${languageRule}`
    }
  }));
}

function microphoneConstraints() {
  const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: { ideal: 1 }
  };
  if (supported.voiceIsolation) audio.voiceIsolation = true;
  return audio;
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
    loadVoiceProfile();
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

function discardConversationItem(itemId, removeTranscript = true) {
  if (itemId && state.dc?.readyState === "open") {
    state.dc.send(JSON.stringify({ type: "conversation.item.delete", item_id: itemId }));
  }
  if (removeTranscript && itemId) document.getElementById(`msg-${CSS.escape(itemId)}`)?.remove();
}

function hasSpokenContent(text) {
  return /[\p{L}\p{N}]/u.test(text);
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
  if (type === "response.created") state.sawOutputBufferEvent = false;
  if (type === "output_audio_buffer.started") {
    state.sawOutputBufferEvent = true;
    if (state.microphoneFallbackTimer) window.clearTimeout(state.microphoneFallbackTimer);
    state.microphoneFallbackTimer = null;
    setAssistantSpeaking(true);
  }
  if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
    state.sawOutputBufferEvent = true;
    setAssistantSpeaking(false);
  }
  if (type === "input_audio_buffer.speech_started") {
    if (state.assistantSpeaking) return;
    state.voiceFrames = []; state.capturingVoice = true; setStatus("Listening…", "listening");
  }
  if (type === "input_audio_buffer.speech_stopped") {
    if (state.assistantSpeaking) return;
    state.capturingVoice = false; state.pendingVoiceMatch = voiceMatchesProfile(state.voiceFrames); setStatus(state.pendingVoiceMatch ? "Thinking…" : "Voice not recognized", state.pendingVoiceMatch ? "live" : "");
  }
  if (type === "conversation.item.input_audio_transcription.delta") {
    const next = (state.userText.get(event.item_id) || "") + (event.delta || "");
    state.userText.set(event.item_id, next);
    if (hasSpokenContent(next)) addMessage("user", next, event.item_id, true);
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = (event.transcript || state.userText.get(event.item_id) || "").trim();
    if (!hasSpokenContent(text)) {
      discardConversationItem(event.item_id);
      state.userText.delete(event.item_id);
      state.pendingVoiceMatch = true;
      setStatus("Listening…", "listening");
      return;
    }
    if (state.pendingVoiceMatch) {
      addMessage("user", text, event.item_id); persist("user", text, event.item_id); requestResponse(text);
    } else {
      addMessage("user", `${text} (ignored: voice did not match)`, event.item_id);
      discardConversationItem(event.item_id, false);
    }
    state.userText.delete(event.item_id); state.pendingVoiceMatch = true;
  }
  if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
    const id = event.item_id || event.response_id || "assistant-live";
    const next = (state.assistantText.get(id) || "") + (event.delta || ""); state.assistantText.set(id, next); addMessage("assistant", next, id, true); setAssistantSpeaking(true);
  }
  if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
    const id = event.item_id || event.response_id || "assistant-live";
    const text = event.transcript || state.assistantText.get(id) || ""; addMessage("assistant", text, id); persist("assistant", text, id); state.assistantText.delete(id);
  }
  if (type === "response.done" && !state.sawOutputBufferEvent) {
    state.microphoneFallbackTimer = window.setTimeout(() => setAssistantSpeaking(false), 1500);
  }
  if (type === "error") { console.error(event); setAssistantSpeaking(false); showToast(event.error?.message || "Realtime connection error"); }
}

async function startMeeting() {
  if (state.started) return;
  ui.start.disabled = true; setStatus("Connecting…", "live");
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(), video: false });
    startVoiceAnalysis(state.stream);
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
    updateVoiceProfileUi();
    $("#headline").textContent = "I’m listening."; $("#subhead").textContent = "Speak naturally. Pause when you’re done, or interrupt whenever you want.";
  } catch (error) { await closeMedia(); setStatus("Couldn’t connect"); showToast(error.message); }
  finally { ui.start.disabled = false; }
}

async function closeMedia() {
  if (state.microphoneFallbackTimer) window.clearTimeout(state.microphoneFallbackTimer);
  state.microphoneFallbackTimer = null; state.assistantSpeaking = false; state.sawOutputBufferEvent = false;
  stopVoiceAnalysis();
  state.dc?.close(); state.pc?.close(); state.stream?.getTracks().forEach((track) => track.stop()); ui.remoteAudio.srcObject = null;
  state.dc = state.pc = state.stream = null;
}

async function endMeeting() {
  const id = state.meetingId; state.started = false; state.meetingId = null; state.lastLanguage = "US English"; await closeMedia();
  if (id) api(`/api/meetings/${id}/end`, { method: "POST", body: "{}" }).catch(console.error);
  ui.start.classList.remove("d-none"); ui.end.classList.add("d-none"); ui.voice.disabled = false; ui.mode.disabled = false;
  updateVoiceProfileUi();
  setStatus("Meeting ended"); $("#headline").textContent = "Whenever you’re ready."; $("#subhead").textContent = "Start another meeting or revisit a past conversation.";
}

ui.start.addEventListener("click", startMeeting); ui.end.addEventListener("click", endMeeting);
ui.enrollVoice.addEventListener("click", enrollVoiceProfile);
ui.removeVoice.addEventListener("click", () => {
  state.voiceProfile = null; state.voiceProfileEnabled = false;
  localStorage.removeItem(VOICE_PROFILE_KEY); localStorage.removeItem(`${VOICE_PROFILE_KEY}-enabled`);
  updateVoiceProfileUi("Voice profile removed.");
});
ui.voiceProfileEnabled.addEventListener("change", () => {
  state.voiceProfileEnabled = ui.voiceProfileEnabled.checked && Boolean(state.voiceProfile);
  localStorage.setItem(`${VOICE_PROFILE_KEY}-enabled`, String(state.voiceProfileEnabled));
  updateVoiceProfileUi();
});
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
