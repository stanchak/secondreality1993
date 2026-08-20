#!/bin/sh
# Serve the glenz port on http://localhost:8093
cd "$(dirname "$0")"
exec python3 -m http.server 8093
