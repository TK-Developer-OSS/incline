# INCLINE

**Your tasks finish while you sleep.** Leave the agent running overnight on a free-tier API or a local model: it paces itself under rate limits, waits out 429s and resumes on its own, and pings your phone when it needs you.

**Source and releases: <https://github.com/TK-Developer-OSS/incline>**

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

#### The `task.md` format

`task.md` lives in the workspace root. If it does not exist, INCLINE creates it with an instruction header at the top that describes the format, so an AI agent such as Claude Code that opens the file can learn the format from the file itself. An existing `task.md` is never overwritten. Prefer the `task_tracker` tool or the MCP tools (`task_list`, `task_create`, `task_update`, `task_note`) over editing by hand: they take the lock, number the tasks, stamp the times and keep the format valid. If you do edit the file directly, follow the rules below, because a strict parser reads it.

- **One task = one section** that starts with `## [#<ID>] <title>`. The ID is a number, the highest existing ID + 1. Only headings of this exact form are tasks; any other heading (the introduction at the top, the `## カテゴリ` category list) is not.
- **Metadata** goes right under the heading, one `- <key>: <value>` per line (order and indent do not matter):

  | Key | Value |
  |---|---|
  | `status` | `未着手` not started, `対応中` in progress, `報告` reported (the work is done, waiting for you to check), `差戻` sent back for rework, `保留` on hold / blocked, `完了` done, `削除` soft-deleted (the row stays in the file). Use these exact words. |
  | `category` | A name from the `## カテゴリ` list (optional). |
  | `priority` | `HIGH`, `MIDDLE` or `LOW` (default `MIDDLE`). |
  | `assignee` | Who works on it: a name such as `TK` or `AI`, or empty. |
  | `creator`, `created` | Who registered it and when (`YYYY-MM-DD HH:MM`). |
  | `updater`, `updated` | Who changed it last and when. Update on every change. |
  | `備考` | Optional free remark. |

- **History** is under a `### 履歴` heading: one `- <YYYY-MM-DD HH:MM> <name>: <text>` line per note. It is **append-only**: add lines at the end, never edit, reformat, reorder or delete existing ones. A line whose text starts with `data-tmp-::` is your unsaved draft from the panel; the AI must not touch it.
- **Categories** are the `- <name>` lines under the `## カテゴリ` heading (default: バグ, タスク, 設計, メモ).

```markdown
## [#12] Fix the login redirect
- status: 対応中
- category: バグ
- priority: HIGH
- assignee: AI
- creator: TK
- created: 2026-10-31 09:00
- updater: AI
- updated: 2026-10-31 09:30
- 備考: reported on the staging site

### 履歴
- 2026-10-31 09:00 TK: The redirect loops after login. Please fix.
- 2026-10-31 09:30 AI: Started. The cause looks like the session cookie path.
```

**Workflow the agent follows.** It sets `対応中` and `assignee: AI` when it starts, adds a history line at each milestone, and when finished writes a final report (what it did, how it checked, what is left) and sets `報告`. Only you set `完了` or `削除`, unless you explicitly ask the agent to. After `差戻` it reads your newest note, redoes the work and reports again. If it needs a decision it adds a history line that starts with `[CONFIRM]` (question, options, its default): the card blinks and your phone is alerted until a later line starting with `[RESOLVED]` cancels it (`[CONFIRM:topic]` / `[RESOLVED:topic]` pair up several at once).

**Locking.** The panel, the tools and other windows write the same file, so a direct edit must first create `task.md.lock` and delete it right after the last edit. A lock younger than 15 minutes means someone else is editing: wait. INCLINE removes a lock that has not been refreshed for 15 minutes or whose process is gone.

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

## Acknowledgments

INCLINE stands on the shoulders of [Cline](https://github.com/cline/cline). The agent, the tool system, the chat UI and the SDK are the work of the Cline team and its many contributors; this fork only adds the parts for running unattended on rate-limited or local models. Thank you to everyone who built and open-sourced Cline under the Apache License 2.0. If you can, use and support the original project too.

## License

[Apache License 2.0](https://github.com/TK-Developer-OSS/incline/blob/dev/LICENSE). See [NOTICE](https://github.com/TK-Developer-OSS/incline/blob/dev/NOTICE) for attribution to the upstream project.
Copyright 2026 Cline Bot Inc. (upstream) and TK-Developer-OSS (modifications).
