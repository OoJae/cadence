"""Minimal merchant webhook receiver for local testing.

Checks both signatures the runner puts on every POST, with the same secret, and
prints which passed:

  X-Cadence-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
  X-CipherPay-Signature: <hex HMAC-SHA256(secret, "<X-CipherPay-Timestamp>.<body>")>

Either fails if its timestamp is more than 5 minutes off. Answers 200 when both
pass, else 401. Usage: CADENCE_WEBHOOK_SECRET=... python3 scripts/webhook-echo.py [port]
"""
import hashlib, hmac, http.server, json, os, re, sys, time
from datetime import datetime, timezone

SECRET = os.environ.get("CADENCE_WEBHOOK_SECRET", "").encode()
TOLERANCE = 300


def cadence_ok(header, body):
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        fresh = abs(time.time() - int(parts["t"])) <= TOLERANCE
    except (KeyError, ValueError):
        return False
    expected = hmac.new(SECRET, parts["t"].encode() + b"." + body, hashlib.sha256).hexdigest()
    return fresh and hmac.compare_digest(expected, parts.get("v1", ""))


def cipherpay_ok(signature, timestamp, body):
    # As CipherPay's documented verifier: the raw body, an ISO 8601 timestamp.
    if not re.fullmatch(r"[a-fA-F0-9]{64}", signature) or not timestamp:
        return False
    try:
        sent = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        return False
    if sent.tzinfo is None or abs((datetime.now(timezone.utc) - sent).total_seconds()) > TOLERANCE:
        return False
    expected = hmac.new(SECRET, timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature.lower(), expected)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        cadence = cadence_ok(self.headers.get("X-Cadence-Signature", ""), body)
        cipherpay = cipherpay_ok(
            self.headers.get("X-CipherPay-Signature", ""), self.headers.get("X-CipherPay-Timestamp", ""), body
        )
        try:
            event = json.loads(body)
        except ValueError:
            event = None
        print(json.dumps({
            "cadence_signature_ok": cadence,
            "cipherpay_signature_ok": cipherpay,
            "delivery_id": self.headers.get("X-CipherPay-Delivery-Id"),
            "event": event,
        }), flush=True)
        self.send_response(200 if cadence and cipherpay else 401)
        self.end_headers()

    def log_message(self, *args):
        pass


if not SECRET:
    sys.exit("set CADENCE_WEBHOOK_SECRET")
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 8799), Handler).serve_forever()
