# INCLINE

**Your tasks finish while you sleep.** Leave the agent running overnight on a free-tier API or a local model: it paces itself under rate limits, waits out 429s and resumes on its own, and pings your phone when it needs you.

**Repository: <https://github.com/TK-Developer-OSS/incline>**

An unofficial fork of [Cline](https://github.com/cline/cline) for VS Code, with the parts you need when you run a coding agent against a rate-limited or local LLM.

**Not affiliated with, endorsed by, or supported by Cline Bot Inc.** Cline's cloud backend (sign-up, login, `*.cline.bot`) is disabled in this fork; bring your own API key or a local model (e.g. Ollama).

## What's different from Cline

### Keeps running without you

- **Request throttling.** Sliding-window RPM/TPM limiting before each model request and tool call. The next request's token use is predicted from the last request plus the estimated size of tool results, and waits are scheduled so you stay under the provider's limit. Settings: `incline.rateLimit.*` (RPM, TPM, RPD, minimum spacing, tool delay).
- **Waits out rate limits.** On a 429 or a quota error the agent shows a countdown, retries with backoff (`incline.rateLimit.maxRetries`, `retryDelaySec`) and resumes by itself. Errors are classified (rate limit, quota, auth, ...) so a status check tells you why it stopped.
- **Usage gauges.** Live RPM, TPM and RPD meters in the task header and chat UI.
- **Watchdog.** If the agent goes idle while tasks assigned to it are still in progress, it is nudged to continue or to write down what it is waiting for (`incline.watchdog.*`). It stays quiet while the only open item is waiting for you.

### Incline Tasks: a backlog you and the AI share

- A bottom panel (and an editor tab) backed by a plain `task.md` in your workspace. Each task has a status (not started, in progress, report, sent back, done), priority, category, assignee, timestamps and a history of notes.
- The agent reads and writes it through a built-in `task_tracker` tool (`incline.taskTracker.aiToolEnabled`); the file is locked so you and the AI do not overwrite each other. Search and filter by category and status, and reorder cards by hand.
- The agent reports when it is done; you decide whether it really is, by marking it done or sending it back.

### Needs-you alerts and phone notifications

- Write `[CONFIRM]` in a task's history when the AI needs a decision (or a test needs your eyes). The card blinks and an urgent push goes to your phone, repeated at intervals until someone writes `[RESOLVED]`.
- Optional [ntfy](https://ntfy.sh) push notifications let you watch progress from your phone without keeping VS Code in view.

### Built-in MCP server

- Each VS Code window runs its own local MCP server (enable it in settings; ports start at `incline.mcp.basePort` and move up so several windows coexist).
- Tasks: `task_list`, `task_create`, `task_update`, `task_note`.
- Sessions (when session control is allowed): `session_status`, `session_wait`, `session_messages`, `session_send`, `session_cancel`, `session_end`. A supervising agent or script can start work, read the latest report, and see why a session stopped. Input sent this way is labelled `[DEBUG]` in the chat so it is never mistaken for yours.

### Other changes

- **Text tool calls.** Middleware that recovers tool calls from models that emit them as plain text (useful with small local models).
- **Settings survive reinstalls.** State writes are locked, verified and audited (`~/.incline/data/logs/state-writes.jsonl`), so an old window cannot overwrite newer settings. Reload all windows after reinstalling.
- **Separate data directory.** Sessions, history and settings live in `~/.incline`, never mixed with an upstream Cline install in `~/.cline`.
- **No Cline cloud.** Sign-up, login, ClinePass, telemetry and cloud sessions are disabled; requests identify themselves as Incline.
- **Terms of use on first run.** You must accept them once before the extension can be used.

## Install

**From the VS Code Marketplace:** search for "INCLINE" in the Extensions view, or run:

```bash
code --install-extension TKDeveloperOSS.incline
```

**From a release file:** download `incline-4.1.25.vsix` from the [release page](https://github.com/TK-Developer-OSS/incline/releases/tag/Installer), then:

```bash
code --install-extension incline-4.1.25.vsix
```

or use *Extensions: Install from VSIX...* in VS Code. The file is self-contained and the same for every OS. Marketplace installs update automatically; a release file does not, so install the new `.vsix` over the old one. After any update, reload every open VS Code window. To verify a release file, compare the file's SHA-256 with the value in the release notes if you want to verify the download.

## Build from source

Requirements: [Bun](https://bun.sh) 1.4.2, Node.js >= 22, GNU make.

```bash
make                 # install deps + build SDK + package -> apps/vscode/incline.vsix
make build-vscode    # rebuild only the extension (SDK already built)
```

Install the result with `code --install-extension apps/vscode/incline.vsix`.

## Acknowledgments

INCLINE stands on the shoulders of [Cline](https://github.com/cline/cline). The agent, the tool system, the chat UI and the SDK are the work of the Cline team and its many contributors; this fork only adds the parts for running unattended on rate-limited or local models. Thank you to everyone who built and open-sourced Cline under the Apache License 2.0. If you can, use and support the original project too.

## License

[Apache License 2.0](./LICENSE). See [NOTICE](./NOTICE) for attribution to the upstream project.
Copyright 2026 Cline Bot Inc. (upstream) and TK-Developer-OSS (modifications).
