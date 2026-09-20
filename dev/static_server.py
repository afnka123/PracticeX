"""Static file server for the preview harness. Sends no-store so edits always show up on reload."""

import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
print(f"preview files on http://localhost:{port} (no-store)")
ThreadingHTTPServer(("127.0.0.1", port), partial(NoCacheHandler, directory=str(ROOT))).serve_forever()
