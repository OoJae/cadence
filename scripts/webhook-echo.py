"""Minimal merchant webhook receiver for local testing: verifies X-Cadence-Signature."""
import hashlib, hmac, http.server, json, os, sys

SECRET = os.environ.get("CADENCE_WEBHOOK_SECRET", "").encode()

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        parts = dict(p.split("=", 1) for p in self.headers.get("X-Cadence-Signature", "").split(","))
        expected = hmac.new(SECRET, f"{parts.get('t','')}.".encode() + body, hashlib.sha256).hexdigest()
        ok = hmac.compare_digest(expected, parts.get("v1", ""))
        print(json.dumps({"signature_ok": ok, "event": json.loads(body)}), flush=True)
        self.send_response(200 if ok else 401)
        self.end_headers()

    def log_message(self, *args):
        pass

http.server.HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8799), Handler).serve_forever()
