"""Offline transport contract check; only contacts a local fixture server."""
import base64
import json
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

seen = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        seen.append((self.path, dict(self.headers)))
        status = 302 if self.path == "/redirect" else 304 if self.path == "/cached" else 200
        self.send_response(status)
        self.send_header("Location", "/should-not-follow")
        self.end_headers()
        try:
            if status != 304:
                self.wfile.write(b"x" * (6 * 1024 * 1024) if self.path == "/big" else b"article")
        except (BrokenPipeError, ConnectionResetError):
            pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    for path, status in [("/ok", 200), ("/redirect", 302), ("/cached", 304), ("/big", None)]:
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("cffi-fetch.py"))],
            input=json.dumps({"url": f"http://127.0.0.1:{server.server_port}{path}",
                              "profile": "cffi-chrome", "headers": {"If-None-Match": "fixture"}}),
            capture_output=True, text=True, check=True, timeout=25,
        )
        payload = json.loads(result.stdout)
        if status is None:
            assert payload.get("error"), payload
        else:
            assert payload["status"] == status, payload
            assert base64.b64decode(payload["body"]) == (b"" if status == 304 else b"article")
    expired = subprocess.run([sys.executable, str(Path(__file__).with_name("cffi-fetch.py"))],
        input=json.dumps({"url": f"http://127.0.0.1:{server.server_port}/must-not-send", "profile": "cffi-chrome", "start_by": "2000-01-01T00:00:00Z"}),
        capture_output=True, text=True, check=True, timeout=5)
    assert "deadline" in json.loads(expired.stdout)["error"]
    assert [path for path, _ in seen] == ["/ok", "/redirect", "/cached", "/big"]
    for _, headers in seen:
        lower = {key.lower(): value for key, value in headers.items()}
        assert "Chrome/136" in lower["user-agent"]
        assert lower["if-none-match"] == "fixture"
    print("curl_cffi contract passed: Chrome headers, conditional requests, no redirects, body cap")
finally:
    server.shutdown()
