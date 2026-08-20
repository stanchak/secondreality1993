#!/usr/bin/env python3
"""Dev server for unreal2 with caching disabled, so edits to the JS modules
show up on a plain refresh (no more stale-module hunting)."""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8094


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *args):
        pass  # quiet


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('', PORT), NoCacheHandler).serve_forever()
