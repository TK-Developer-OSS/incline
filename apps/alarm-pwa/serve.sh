#!/usr/bin/env bash
# Serve INCLINE Alarm on the local network so you can open it on a phone on the same Wi-Fi (no GitHub needed).
#   ./serve.sh [port]      (default 8765; stop with Ctrl+C, or kill the printed PID)
# Plain http is enough to use the alarm (stream, polling, siren, vibration). Over http the browser does NOT offer
# the screen wake lock / full install, so set the phone's screen timeout to "never" while it charges.
set -euo pipefail
PORT="${1:-8765}"
cd "$(dirname "$0")"
echo "INCLINE Alarm: open one of these on the phone (same Wi-Fi):"
ip -4 -o addr show scope global | awk -v p="$PORT" '{split($4,a,"/"); printf "  http://%s:%s/\n", a[1], p}'
echo "Serving $(pwd) (static files only). Stop with Ctrl+C."
exec python3 -m http.server "$PORT" --bind 0.0.0.0
