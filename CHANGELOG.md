# Changelog

All notable changes to STR Companion. The format follows [Keep a Changelog](https://keepachangelog.com/); versions follow [Semantic Versioning](https://semver.org/).

## [1.5.0] — 2026-11-01

### Added
- **✳ AI Assistant** — a new page that connects to a **local LLM** (LM Studio, Ollama, llama.cpp, or anything that speaks the OpenAI API) so a local AI agent can help you inside the app.
  - **Reads your live state** — health checks, mods, logs, and configs — so it can troubleshoot without you copy-pasting.
  - **Match a friend's setup** — paste a friend's `STR2-` code and it compares your setups, explains the differences, and can apply the load-order match (missing mods are reported, not downloaded).
  - **Change config values** — e.g. set the server password, or any value in `STServer.ini`, `SkyrimPrefs.ini`, `Skyrim.ini`, `SkyrimCustom.ini` or Engine Fixes.
  - **Run the safe one-click fixes** — the same actions as the Dashboard (back up Creation Club, back up/restore files, activate plugins, Steam auto-update, acknowledge versions).
  - **Streaming chat** with live tool-activity indicators and a stop button.
  - **Private by design** — the optional API key is stored with Electron `safeStorage` and never returned to the UI; all LLM traffic goes through the main process. The model can **never delete anything**.

### Notes
- New core module `src/core/llm.js` (OpenAI-compatible client: SSE streaming, tool-call reassembly, agent loop).
- 9 new unit tests covering the LLM client (SSE parsing, completion parsing, tool-call reassembly, agent loop against a real fake server, friendly connection errors).

## [1.4.1]
### Fixed
- Quick Setup no longer crashes when a Nexus API key is already saved.
- Deeper UI smoke checks across all pages.

## [1.4.0]
### Added
- **Steam Deck automation** — press Play in Gaming Mode to start co-op under Proton, with saves snapshotted first; "Add to Steam" so the app opens in Gaming Mode.
- **Router check** — finds your router, opens the server port with UPnP, and spots CGNAT / double NAT.
- **Bug reports** — one zip on your Desktop with logs, crash reports, plugin lists and diagnostics (passwords removed).
- **Self-update** — the sidebar shows new versions; the portable exe and AppImage update in place, SHA-256 verified.

## [1.2.0]
### Added
- **Party sync** — save friends' setup codes and see at a glance who's in sync.
- **Crash report reader** — names the mods showing up most in each crash.
- **Automatic save snapshots** before every launch.

## [1.0.0]
### Added
- Initial release: Dashboard, Quick Setup, Play & Server, Mods, Cleanup, Config Editor, Friends Sync, Backups and Logs for Skyrim Together Reborn co-op (Windows and Linux).
