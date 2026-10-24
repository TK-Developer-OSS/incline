# Changelog

INCLINE is an unofficial fork of Cline. Changes before the fork point are documented upstream.

## 4.1.28

**Important: upgrade if you use 4.1.26 or earlier with a rate-limited API key (for example the Gemini free tier).** Older builds could keep sending requests after the provider answered 429 / quota exceeded: the SDK retried each request up to 5 more times, the auto-retry loop restarted the whole turn on a fixed 60-second timer, and the idle watchdog started new turns on top of that. A single stuck session could send more than a thousand requests overnight and earn a long penalty from the provider.

### Rate limits and retries
- A 429 (quota / rate limit) is retried at most 2 times, waiting 60 s then 120 s (doubling, up to 20 min). A server-provided "retry in Ns" hint is honored when it is longer. After five 429s in a row without a success, a circuit breaker pauses requests to that API key for one hour; changing the API key lifts the pause at once.
- 502 / 503 / 504 (overloaded, unavailable, timeout) are retried without a limit, with a doubling wait (up to 5 min). They never trip the circuit breaker.
- 429 / 502 / 503 / 504 responses are returned immediately for every provider instead of being retried inside the SDK. Gemini requests are also spaced apart at the HTTP level.
- Closing the session, switching away, pressing "+" or Cancel stops any background auto-retry. When the retries are exhausted the idle watchdog stays quiet until a request succeeds, and it only nudges when the agent stopped after asking itself a question or without finishing.
- Throttling is applied to tools too: the agent waits before a tool when RPM / TPM has reached 60% of the configured limit. New fixed waits per request, before each tool and after each tool (all configurable).
- New "Rate limit / auto-retry" section in the INCLINE settings panel (max retries, retry wait, minimum spacing, RPM, TPM, per-request / per-tool waits). Defaults: 2 retries, Gemini 5 RPM / 150k TPM / 15 s spacing, 5 s per request, 10 s before and 5 s after each tool. Raise RPM / TPM if your key is on a paid tier.

### Visibility
- Errors are shown in a frame with the HTTP status and kind (for example "HTTP 429 · quota / rate limit"); the provider's original response is under "Original error".
- Each retry is appended as its own line, so earlier attempts are no longer overwritten.
- New operation log at `~/.incline/data/logs/activity.log` (requests, waits, tools, retries, breaker, watchdog), one line per event.

### Settings are no longer overwritten
- Typing in a settings field could be replaced by an older value that arrived late, dropping characters or saving the old value. Fixed.
- A window running an older build no longer overwrites settings saved by a newer build (it pauses saving and asks you to reload). The hourly remote-config refresh, which wrote to the settings file every hour for nothing, is off.
- The settings panel buttons are now "Save" and "Cancel". Settings are still saved as you type, so "Cancel" only closes the panel.

## Unreleased (dev)

- Request throttling (RPM/TPM), usage gauges, and the Incline Tasks panel.
- Data directory separated from Cline (~/.incline).
- Cline cloud backend, telemetry, accounts and branding removed.
- Terms of use must be accepted on first run.
