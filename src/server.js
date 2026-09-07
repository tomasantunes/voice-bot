import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import helmet from "helmet";
import mysql from "mysql2/promise";
import { buildInstructions, modes, voices } from "./modes.js";

const required = ["OPENAI_API_KEY", "APP_USERNAME", "APP_PASSWORD", "COOKIE_SECRET", "MYSQL_DATABASE", "MYSQL_USER"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);

const app = express();
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === "production";
const cookieName = production ? "__Host-voice_session" : "voice_session";
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4"
});

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(express.text({ type: "application/sdp", limit: "1mb" }));

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function sign(value) {
  return crypto.createHmac("sha256", process.env.COOKIE_SECRET).update(value).digest("base64url");
}

function makeSession() {
  const payload = Buffer.from(JSON.stringify({ u: process.env.APP_USERNAME, exp: Date.now() + 12 * 60 * 60 * 1000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function cookieValue(req, name) {
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0 ? ["", ""] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
  return cookies[name];
}

function authenticated(req) {
  try {
    const token = cookieValue(req, cookieName);
    if (!token) return false;
    const [payload, signature] = token.split(".");
    if (!payload || !signature || !safeEqual(signature, sign(payload))) return false;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    return session.u === process.env.APP_USERNAME && session.exp > Date.now();
  } catch { return false; }
}

function requireAuth(req, res, next) {
  if (!authenticated(req)) return res.status(401).json({ error: "Authentication required" });
  next();
}

const loginAttempts = new Map();
app.post("/api/login", (req, res) => {
  const key = req.ip;
  const record = loginAttempts.get(key) || { count: 0, reset: Date.now() + 15 * 60_000 };
  if (record.reset < Date.now()) Object.assign(record, { count: 0, reset: Date.now() + 15 * 60_000 });
  if (record.count >= 10) return res.status(429).json({ error: "Too many attempts. Try again later." });
  const valid = safeEqual(req.body?.username || "", process.env.APP_USERNAME) && safeEqual(req.body?.password || "", process.env.APP_PASSWORD);
  if (!valid) {
    record.count += 1;
    loginAttempts.set(key, record);
    return res.status(401).json({ error: "Invalid username or password" });
  }
  loginAttempts.delete(key);
  res.cookie(cookieName, makeSession(), { httpOnly: true, sameSite: "strict", secure: production, path: "/", maxAge: 12 * 60 * 60 * 1000 });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(cookieName, { httpOnly: true, sameSite: "strict", secure: production, path: "/" });
  res.json({ ok: true });
});

app.get("/api/bootstrap", async (req, res, next) => {
  if (!authenticated(req)) return res.json({ authenticated: false });
  try {
    const [rows] = await pool.execute("SELECT voice, mode FROM user_settings WHERE username = ?", [process.env.APP_USERNAME]);
    res.json({ authenticated: true, voices, modes: Object.keys(modes), settings: rows[0] || { voice: "marin", mode: "default" } });
  } catch (error) { next(error); }
});

app.put("/api/settings", requireAuth, async (req, res, next) => {
  const { voice, mode } = req.body || {};
  if (!voices.includes(voice) || !Object.hasOwn(modes, mode)) return res.status(400).json({ error: "Invalid voice or mode" });
  try {
    await pool.execute(
      "INSERT INTO user_settings (username, voice, mode) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE voice = VALUES(voice), mode = VALUES(mode)",
      [process.env.APP_USERNAME, voice, mode]
    );
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post("/api/realtime", requireAuth, async (req, res, next) => {
  const { sdp, voice, mode } = req.body || {};
  if (typeof sdp !== "string" || !sdp.startsWith("v=0")) return res.status(400).json({ error: "Invalid WebRTC offer" });
  if (!voices.includes(voice) || !Object.hasOwn(modes, mode)) return res.status(400).json({ error: "Invalid voice or mode" });
  try {
    const [meeting] = await pool.execute("INSERT INTO meetings (username, voice, mode) VALUES (?, ?, ?)", [process.env.APP_USERNAME, voice, mode]);
    const form = new FormData();
    form.set("sdp", sdp);
    form.set("session", JSON.stringify({
      type: "realtime",
      model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
      instructions: buildInstructions(mode),
      output_modalities: ["audio"],
      audio: {
        input: {
          noise_reduction: { type: "far_field" },
          transcription: {
            model: "gpt-transcribe",
            prompt: "This is a close-microphone conversation in English or European Portuguese. Ignore distant background conversations and crowd noise."
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.72,
            prefix_padding_ms: 300,
            silence_duration_ms: 850,
            create_response: false,
            interrupt_response: false
          }
        },
        output: { voice }
      }
    }));
    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form
    });
    const answer = await response.text();
    if (!response.ok) {
      await pool.execute("UPDATE meetings SET ended_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [meeting.insertId]);
      console.error("OpenAI Realtime error", response.status, answer);
      return res.status(502).json({ error: "Could not start the OpenAI voice session" });
    }
    res.type("application/sdp").set("X-Meeting-Id", String(meeting.insertId)).send(answer);
  } catch (error) { next(error); }
});

app.post("/api/meetings/:id/messages", requireAuth, async (req, res, next) => {
  const meetingId = Number(req.params.id);
  const { eventId, role, content } = req.body || {};
  if (!Number.isSafeInteger(meetingId) || meetingId < 1 || !["user", "assistant"].includes(role) || typeof eventId !== "string" || !eventId || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "Invalid message" });
  }
  try {
    const [result] = await pool.execute(
      "INSERT IGNORE INTO messages (meeting_id, client_event_id, role, content) SELECT id, ?, ?, ? FROM meetings WHERE id = ? AND username = ?",
      [eventId.slice(0, 191), role, content.trim().slice(0, 65535), meetingId, process.env.APP_USERNAME]
    );
    if (!result.affectedRows) return res.status(404).json({ error: "Meeting not found or message already saved" });
    res.status(201).json({ ok: true });
  } catch (error) { next(error); }
});

app.post("/api/meetings/:id/end", requireAuth, async (req, res, next) => {
  try {
    await pool.execute("UPDATE meetings SET ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP(3)) WHERE id = ? AND username = ?", [Number(req.params.id), process.env.APP_USERNAME]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get("/api/meetings", requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.execute("SELECT id, voice, mode, started_at, ended_at FROM meetings WHERE username = ? ORDER BY started_at DESC LIMIT 20", [process.env.APP_USERNAME]);
    res.json(rows);
  } catch (error) { next(error); }
});

app.get("/api/meetings/:id/messages", requireAuth, async (req, res, next) => {
  try {
    const [rows] = await pool.execute(
      "SELECT msg.id, msg.role, msg.content, msg.created_at FROM messages msg JOIN meetings mtg ON mtg.id = msg.meeting_id WHERE msg.meeting_id = ? AND mtg.username = ? ORDER BY msg.created_at, msg.id",
      [Number(req.params.id), process.env.APP_USERNAME]
    );
    res.json(rows);
  } catch (error) { next(error); }
});

app.use(express.static("public", { extensions: ["html"], maxAge: production ? "1h" : 0 }));
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: "Something went wrong" });
});

const server = app.listen(port, () => console.log(`Voice meeting app listening on http://localhost:${port}`));
async function shutdown() {
  server.close(async () => { await pool.end(); process.exit(0); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
