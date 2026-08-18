#!/usr/bin/env bash
# Start / stop the Curiosity Channel studio UI.
#
#   ./scripts/ui.sh start     # launch the UI and open it in the browser
#   ./scripts/ui.sh stop      # stop the UI
#   ./scripts/ui.sh restart
#
# Port can be overridden:  UI_PORT=4200 ./scripts/ui.sh start

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${UI_PORT:-4100}"
LOG="/tmp/curiosity-ui.log"
URL="http://localhost:${PORT}"

running() { lsof -ti "tcp:${PORT}" >/dev/null 2>&1; }

case "${1:-start}" in
  start)
    if running; then
      echo "UI already running → ${URL}"
    else
      ( cd "$ROOT" && nohup env UI_PORT="$PORT" npm run ui >"$LOG" 2>&1 < /dev/null & )
      sleep 1
      echo "UI started → ${URL}   (logs: ${LOG})"
      command -v open >/dev/null && open "$URL" || true
    fi
    ;;
  stop)
    if running; then
      lsof -ti "tcp:${PORT}" | xargs kill 2>/dev/null || true
      echo "UI stopped."
    else
      echo "UI not running."
    fi
    ;;
  restart)
    "$0" stop || true
    sleep 1
    "$0" start
    ;;
  *)
    echo "Usage: $0 start|stop|restart"
    exit 1
    ;;
esac
