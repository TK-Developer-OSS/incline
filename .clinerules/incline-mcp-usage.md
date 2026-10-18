# How to operate the INCLINE MCP server

INCLINE runs an MCP server per VS Code window (127.0.0.1 only, token authentication). Use it instead of editing
`task.md` directly. Tools: `task_list`, `task_create`, `task_update`, `task_note`, `post_message`, `read_messages`,
`ack_message`, `rate_status`, and (only when "Allow session control over MCP" is on) `session_send`,
`session_status`, `session_messages`, `session_cancel`, `session_end`, `session_wait`.

## Standard mode (same window) — nothing to turn on
INCLINE puts the connection info into the environment variables of the window's extension host:
`INCLINE_MCP_URL`, `INCLINE_MCP_TOKEN`, `INCLINE_MCP_PORT`. They are only in memory (never written to a file).
A Claude Code session started in that window, and its Bash tool, inherit them; so do terminals opened afterwards.

```
scripts/incline-mcp tools
scripts/incline-mcp call task_list '{}'
scripts/incline-mcp call task_note '{"id": 12, "text": "Implemented X; tests pass; Y is unverified."}'
```

If `echo $INCLINE_MCP_URL` is empty, the process was started before INCLINE activated (or MCP is disabled in the
INCLINE settings tab). Start a new Claude session / terminal in that window. Do NOT ask for "debug mode": it is
not needed for operating the MCP of the window you are running in.

## Debug mode (another window / an external process)
A process in a different VS Code window has a different parent process, so the environment variables cannot reach it.
Turn on "Debug mode" in the INCLINE settings tab: the connection info is then also written to
`~/.incline/run/mcp-<port>.json` (mode 0600; contains `url`, `token`, `workspace`). `scripts/incline-mcp --workspace
<folder> ...` finds the file whose `workspace` matches.

## Raw HTTP (any client)
```
curl -s -X POST "$INCLINE_MCP_URL" -H "Authorization: Bearer $INCLINE_MCP_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"task_list","arguments":{}}}'
```
The reply is one `data: {...}` line (SSE). A 401 means the token is stale (INCLINE restarted): start a new session.
