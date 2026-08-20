#!/usr/bin/env bash
# shot.sh <seconds> <outfile.png>
#
# Captures a screenshot of http://localhost:8093/?silent&jump=<seconds>
# after ~3 real seconds for the page to boot/render, at a 1280x960
# viewport. Also writes browser console output (console.log/warn/error,
# uncaught exceptions, failed network requests) to <outfile>.log next to
# the PNG.
#
# Requires the harness in tools/harness/ (playwright + chromium installed
# via `npm install` and `npx playwright install chromium`).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$SCRIPT_DIR/harness"

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <seconds> <outfile.png>" >&2
  exit 2
fi

SECONDS_ARG="$1"
OUTFILE="$2"

case "$OUTFILE" in
  *.png) LOGFILE="${OUTFILE%.png}.log" ;;
  *) LOGFILE="${OUTFILE}.log" ;;
esac

# Resolve OUTFILE/LOGFILE to absolute paths (so relative outputs land in
# the caller's cwd, not tools/harness/).
case "$OUTFILE" in
  /*) : ;;
  *) OUTFILE="$(pwd)/$OUTFILE" ;;
esac
case "$LOGFILE" in
  /*) : ;;
  *) LOGFILE="$(pwd)/$LOGFILE" ;;
esac

URL="http://localhost:8093/?silent&jump=${SECONDS_ARG}"
SETTLE_MS=3000

if [ ! -d "$HARNESS_DIR/node_modules/playwright" ]; then
  echo "shot.sh: playwright not installed in $HARNESS_DIR (run 'npm install && npx playwright install chromium' there)" >&2
  exit 1
fi

node "$HARNESS_DIR/shot.js" "$URL" "$SETTLE_MS" "$OUTFILE" "$LOGFILE"
