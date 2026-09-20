"""PracticeX backend.

Holds the API keys and enforces the hourly cap, so neither ships inside the extension.
Run: .venv/bin/python app.py   (reads settings from environment or a .env file next to this one)
"""

import base64
import binascii
import collections
import hmac
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_dotenv():
    env = HERE / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

import llm  # noqa: E402  (after .env so the SDK clients see the keys)

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
HOURLY_CAP = int(os.environ.get("HOURLY_CAP", "50"))
FOUNDER_HOURLY_CAP = int(os.environ.get("FOUNDER_HOURLY_CAP", "200"))
# Per-IP cap stops one machine from rotating install ids to dodge the per-user cap.
IP_HOURLY_CAP = int(os.environ.get("IP_HOURLY_CAP", str(HOURLY_CAP * 3)))
# Ceiling across all users, as a last line of defence for the API bill.
GLOBAL_HOURLY_CAP = int(os.environ.get("GLOBAL_HOURLY_CAP", "600"))
FOUNDER_TOKEN = os.environ.get("FOUNDER_TOKEN", "")
# In production, set this to the packed extension's id (comma-separated for more than one) so only
# that extension gets CORS. Left empty, any extension and localhost may call the server.
ALLOWED_EXTENSION_IDS = {i.strip() for i in os.environ.get("ALLOWED_EXTENSION_IDS", "").split(",") if i.strip()}
# Reports have their own small budget: they cost no model call, but each one is written to disk.
REPORT_HOURLY_CAP = int(os.environ.get("REPORT_HOURLY_CAP", "10"))
MAX_BODY = 8 * 1024 * 1024

# Hosts with an ephemeral disk can point this at a mounted one.
REPORTS_FILE = Path(os.environ.get("REPORTS_FILE", HERE / "reports.jsonl"))
INSTALL_ID_RE = re.compile(r"^[A-Za-z0-9-]{16,64}$")


def load_models():
    config = json.loads((HERE / "models.json").read_text())
    usable = []
    for m in config["models"]:
        if not m.get("enabled"):
            continue
        if os.environ.get(m["api_key_env"]):
            usable.append(m)
    return config, usable


MODEL_CONFIG, MODELS = load_models()


class HourlyLimiter:
    """Sliding one-hour window per key."""

    def __init__(self):
        self._hits = collections.defaultdict(collections.deque)
        self._lock = threading.Lock()

    def _trim(self, q, now):
        while q and q[0] <= now - 3600:
            q.popleft()

    def peek(self, key):
        now = time.time()
        with self._lock:
            q = self._hits[key]
            self._trim(q, now)
            return len(q), (q[0] + 3600 if q else None)

    def try_take(self, checks):
        """checks: list of (key, cap). Takes one from every key only if all are under cap."""
        now = time.time()
        with self._lock:
            for key, cap in checks:
                q = self._hits[key]
                self._trim(q, now)
                if len(q) >= cap:
                    return False, key, q[0] + 3600
            for key, _ in checks:
                self._hits[key].append(now)
            return True, None, None


limiter = HourlyLimiter()


class ApiError(Exception):
    def __init__(self, status, message, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra


class Handler(BaseHTTPRequestHandler):
    server_version = "PracticeX/1"

    # --- plumbing -------------------------------------------------------

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _allowed_origin(self, origin):
        if origin.startswith("chrome-extension://"):
            return not ALLOWED_EXTENSION_IDS or origin.split("//", 1)[1] in ALLOWED_EXTENSION_IDS
        # The dev preview runs on localhost; a deployment that names its extension does not need it.
        return origin.startswith("http://localhost") and not ALLOWED_EXTENSION_IDS

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin and self._allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type, X-PracticeX-Install, X-PracticeX-Founder, X-StudyX-Install, X-StudyX-Founder"
            )

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        self._dispatch({"/v1/config": self.get_config, "/healthz": self.get_health})

    def do_POST(self):
        self._dispatch(
            {
                "/v1/generate": self.post_generate,
                "/v1/prerequisite": self.post_prerequisite,
                "/v1/diagram": self.post_diagram,
                "/v1/check": self.post_check,
                "/v1/report": self.post_report,
            }
        )

    def _dispatch(self, routes):
        route = routes.get(self.path.split("?")[0])
        if route is None:
            return self._send(404, {"error": "Not found."})
        try:
            result = route()
            if result is not None:  # streaming routes have already answered
                self._send(200, result)
        except ApiError as e:
            self._send(e.status, {"error": e.message, **e.extra})
        except (llm.ModelRefused, llm.ModelFailed) as e:
            self._send(502, {"error": str(e)})
        except Exception as e:  # keep the server up; details go to the log only
            print(f"[error] {self.path}: {type(e).__name__}: {e}")
            self._send(500, {"error": "Something went wrong on the server."})

    # --- streaming ---------------------------------------------------------
    # Newline-delimited JSON events: meta (usage), delta (model text as it arrives), then done or error.

    def _event(self, event):
        self.wfile.write((json.dumps(event) + "\n").encode())
        self.wfile.flush()

    def _stream(self, install, events, extra=None):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True  # no Content-Length: the body ends when the connection closes
        try:
            self._event({"type": "meta", "usage": self._usage(install)})
            while True:
                try:
                    delta = next(events)
                except StopIteration as done:
                    self._event({"type": "done", "result": {**done.value, **(extra or {})}})
                    return
                self._event({"type": "delta", "text": delta})
        except (BrokenPipeError, ConnectionResetError):
            print(f"[stream] {self.path}: client left early")
        except Exception as e:
            if isinstance(e, (llm.ModelRefused, llm.ModelFailed)):
                message = str(e)
            else:
                print(f"[error] {self.path} mid-stream: {type(e).__name__}: {e}")
                message = "Something went wrong on the server."
            try:
                self._event({"type": "error", "error": message})
            except OSError:
                pass
        finally:
            events.close()  # stops the model call if the student left

    @staticmethod
    def _collect(events):
        try:
            while True:
                next(events)
        except StopIteration as done:
            return done.value

    def _json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ApiError(413, "Screenshot is too large. Crop to the problem.")
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise ApiError(400, "Bad request.")

    # --- identity and limits ---------------------------------------------

    def _install_id(self):
        # X-StudyX-* is the pre-rename name of these headers: an extension that has not been reloaded
        # yet still sends it. Drop the fallback once every client is on a build that sends the new one.
        install = self.headers.get("X-PracticeX-Install") or self.headers.get("X-StudyX-Install", "")
        if not INSTALL_ID_RE.match(install):
            raise ApiError(400, "Missing install id. Reload the extension.")
        return install

    def _is_founder(self):
        token = self.headers.get("X-PracticeX-Founder") or self.headers.get("X-StudyX-Founder", "")
        return bool(FOUNDER_TOKEN) and hmac.compare_digest(token, FOUNDER_TOKEN)

    def _ip(self):
        # Only trust X-Forwarded-For when a reverse proxy you control sets it.
        if os.environ.get("TRUST_PROXY") == "1":
            return self.headers.get("X-Forwarded-For", self.client_address[0]).split(",")[0].strip()
        return self.client_address[0]

    def _cap(self):
        return FOUNDER_HOURLY_CAP if self._is_founder() else HOURLY_CAP

    def _usage(self, install):
        used, resets_at = limiter.peek("user:" + install)
        return {"used": used, "limit": self._cap(), "resets_at": resets_at}

    def _spend_one(self, install):
        checks = [("user:" + install, self._cap()), ("global", GLOBAL_HOURLY_CAP)]
        if not self._is_founder():
            checks.append(("ip:" + self._ip(), IP_HOURLY_CAP))
        ok, key, resets_at = limiter.try_take(checks)
        if not ok:
            if key == "global":
                raise ApiError(429, "PracticeX is at capacity this hour.", resets_at=resets_at)
            raise ApiError(429, "Hourly limit reached.", resets_at=resets_at, usage=self._usage(install))

    @staticmethod
    def _verbosity(body):
        verbosity = body.get("verbosity", "standard")
        return verbosity if verbosity in llm.VERBOSITY else "standard"

    def _model(self, requested):
        founder = self._is_founder()
        allowed = [m for m in MODELS if founder or m["tier"] == "public"]
        for m in allowed:
            if m["id"] == requested:
                return m
        default = MODEL_CONFIG["default_founder" if founder else "default_public"]
        for m in allowed:
            if m["id"] == default:
                return m
        if not allowed:
            raise ApiError(503, "No models are configured on the server.")
        return allowed[0]

    # --- routes ----------------------------------------------------------

    # Uptime check for the host. It touches nothing and needs no install id.
    def get_health(self):
        return {"ok": True, "models": len(MODELS)}

    def get_config(self):
        install = self._install_id()
        founder = self._is_founder()
        models = [m for m in MODELS if founder or m["tier"] == "public"]
        return {
            "founder": founder,
            "models": [{"id": m["id"], "label": m["label"]} for m in models],
            "default_model": self._model("")["id"] if models else None,
            "usage": self._usage(install),
        }

    def post_generate(self):
        install = self._install_id()
        body = self._json_body()
        media_type = body.get("media_type")
        if media_type not in ("image/png", "image/jpeg"):
            raise ApiError(400, "Screenshot must be PNG or JPEG.")
        image = body.get("image") or ""
        try:
            base64.b64decode(image, validate=True)
        except (binascii.Error, ValueError):
            raise ApiError(400, "Screenshot could not be read.")
        if not image:
            raise ApiError(400, "Screenshot is empty.")
        difficulty = llm.difficulty_level(body.get("difficulty", 50))
        verbosity = self._verbosity(body)
        answer_format = body.get("answer_format", "free")
        if answer_format not in llm.FORMATS:
            answer_format = "free"
        answer_mix = body.get("answer_mix", 50)
        if not isinstance(answer_mix, (int, float)) or isinstance(answer_mix, bool):
            answer_mix = 50
        answer_mix = max(0, min(100, answer_mix))
        count = body.get("count", 3)
        if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= llm.MAX_PROBLEMS:
            count = 3
        model = self._model(body.get("model", ""))

        self._spend_one(install)
        self._stream(install, llm.generate(model, image, media_type, difficulty, count, verbosity, answer_format, answer_mix), {"model": model["id"]})

    def post_prerequisite(self):
        install = self._install_id()
        body = self._json_body()
        topic = str(body.get("topic", ""))[:200]
        question = str(body.get("question", ""))[:4000]
        if not question:
            raise ApiError(400, "No question to look up.")
        verbosity = self._verbosity(body)
        model = self._model(body.get("model", ""))

        self._spend_one(install)
        self._stream(install, llm.prerequisite(model, topic, question, verbosity))

    def post_diagram(self):
        install = self._install_id()
        body = self._json_body()
        topic = str(body.get("topic", ""))[:200]
        question = str(body.get("question", ""))[:4000]
        if not question:
            raise ApiError(400, "No question to draw.")
        if body.get("subject") in llm.NO_DIAGRAM_SUBJECTS:
            raise ApiError(400, "Diagrams are not available for this subject.")
        model = self._model(body.get("model", ""))

        self._spend_one(install)
        result = self._collect(llm.diagram(model, topic, question))  # only useful whole, so not streamed
        if not result["diagram"]:
            raise ApiError(502, "The model could not draw a diagram for this question.")
        return {**result, "usage": self._usage(install)}

    def post_check(self):
        install = self._install_id()
        body = self._json_body()
        question = str(body.get("question", ""))[:4000]
        answer = str(body.get("answer", ""))[:1000]
        attempt = str(body.get("attempt", "")).strip()[:500]
        if not (question and answer and attempt):
            raise ApiError(400, "Nothing to check.")
        model = self._model(body.get("model", ""))

        self._spend_one(install)
        result = self._collect(llm.check(model, question, answer, attempt))
        return {**result, "usage": self._usage(install)}

    def post_report(self):
        install = self._install_id()
        body = self._json_body()
        checks = [("report:" + install, REPORT_HOURLY_CAP), ("report-ip:" + self._ip(), REPORT_HOURLY_CAP * 3)]
        ok, _, resets_at = limiter.try_take(checks)
        if not ok:
            raise ApiError(429, "Too many reports this hour.", resets_at=resets_at)
        record = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "install": install,
            "model": str(body.get("model", ""))[:100],
            "topic": str(body.get("topic", ""))[:200],
            "question": str(body.get("question", ""))[:2000],
            "answer": str(body.get("answer", ""))[:1000],
            "steps": [str(s)[:1000] for s in body.get("steps", [])][:20],
            "reason": str(body.get("reason", ""))[:100],
        }
        with open(REPORTS_FILE, "a") as f:
            f.write(json.dumps(record) + "\n")
        return {"ok": True}

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {self.command} {self.path} {args[1] if len(args) > 1 else ''}")


def main():
    if not MODELS:
        print("warning: no models available. Set OPENAI_API_KEY in the environment or server/.env.")
    print(f"models: {', '.join(m['id'] + ' (' + m['tier'] + ')' for m in MODELS)}")
    print(f"PracticeX server on {HOST}:{PORT}  cap {HOURLY_CAP}/hr per user")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
