# Voice Bot

A private Express, Bootstrap 5, MySQL, and OpenAI Realtime API voice meeting app. It uses WebRTC for low-latency two-way audio, semantic voice activity detection for automatic turns and interruption, live transcripts, and MySQL persistence.

## Setup

1. Install Node.js 20+ and MySQL 8+.
2. Run `create-tables.sql` in MySQL.
3. Fill in the included `.env` file with every secret and database setting. `.env.example` is a safe template you can keep in source control.
4. Run `npm install`.
5. Run `npm start`, then open `http://localhost:3000`.

The browser will request microphone permission when you start a meeting. In production, serve the app over HTTPS; browser microphone access requires a secure context except on localhost.

## Environment

- `OPENAI_API_KEY`: kept on the server and never sent to the browser.
- `APP_USERNAME` / `APP_PASSWORD`: single-user app login.
- `COOKIE_SECRET`: a random value of at least 32 characters.
- `MYSQL_*`: database connection settings.
- `OPENAI_REALTIME_MODEL`: defaults to `gpt-realtime`.
- `OPENAI_SEARCH_MODEL`: model used to synthesize web-search findings; defaults to `gpt-5.4-mini`.

## Notes

- Changing voice or mode affects the next meeting.
- Transcript saves occur after OpenAI marks each user or assistant transcript complete.
- Conversation audio is transported directly through the WebRTC session; this app stores text transcripts, not audio recordings.
- The Realtime model automatically calls a server-side web-search tool for current, changing, niche, or explicitly requested online information.
