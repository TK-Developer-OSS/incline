# INCLINE Alarm (PWA)

A phone web app that wakes you up when INCLINE needs your decision.

- INCLINE posts a message containing **`[FL-Alarm]`** to your ntfy topic (when an AI writes `[CONFIRM]` on a task).
- This page checks the topic every 30 seconds (and listens live). When it finds `[FL-Alarm]`, it starts a **loud siren,
  vibration and a flashing screen** until you tap **Acknowledge** (or **Snooze 5 min**).
- Acknowledge posts `ACK: ...` back to the topic; INCLINE then stops its reminders.

## Get it onto the phone
- **Now (before it is published): from this PC over the local network.** Run `./serve.sh` in this folder. It prints URLs such as
  `http://192.168.12.6:8765/`; open one on the phone (same Wi-Fi). Plain http is enough for the alarm itself (live stream, 30 s polling,
  siren, vibration). Over http the browser does **not** offer the screen wake lock or a full install, so set the phone's screen
  timeout to "never" while it charges; "Add to Home Screen" still gives a shortcut. Stop the server with Ctrl+C when done.
- **Later (published): `https://github.com/TK-Developer-OSS/incline/` -> `fl-alarm/`.** All paths in the app are relative, so
  the folder works as-is under any sub-path (e.g. served by GitHub Pages as `.../incline/fl-alarm/`). Over HTTPS the browser
  offers the full install and the wake lock.

## Use it
1. Host these static files over **HTTPS** (needed for install / screen wake lock): e.g. GitHub Pages, Netlify, or any static host.
   For a quick local try: `python3 -m http.server 8080` in this folder and open `http://localhost:8080` on the same machine.
2. Open the page on the phone, enter the **same ntfy topic** as in the INCLINE settings tab, tap **Start listening**.
   (`?topic=NAME&autostart=1` in the URL fills it in and starts automatically.)
3. "Add to Home Screen" to install it. Keep it open with the screen on and charging.
4. In INCLINE run the command **INCLINE: Send Test Alarm** to check the whole path.

## Limits (PoC)
- A web page cannot ring while it is closed or the phone is asleep (iOS is stricter). Keep it open, charging.
- It does not bypass silent / do-not-disturb / focus modes (by design).
- The ntfy topic name is the only secret: use a long unguessable name and never put secrets in messages.
