"""Server tests with the model call stubbed out. Run: .venv/bin/python -m unittest test_server"""

import base64
import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

os.environ.update(OPENAI_API_KEY="sk-test", HOURLY_CAP="3", FOUNDER_TOKEN="founder-secret", GLOBAL_HOURLY_CAP="100")

import app  # noqa: E402
import llm  # noqa: E402

IMAGE = base64.b64encode(b"\xff\xd8\xff fake jpeg").decode()


def fake_generate(model, image, media_type, difficulty, count, verbosity, answer_format="free", answer_mix=50):
    yield '{"readable": '
    yield "true}"
    return {"readable": True, "topic": "Linear equations", "count": count, "verbosity": verbosity,
            "answer_format": answer_format, "answer_mix": answer_mix, "difficulty": difficulty,
            "problems": [{"question": "Solve", "answer": "4", "steps": []}]}


def fake_diagram(model, topic, question, want="drawing"):
    yield "{}"
    if question == "impossible":
        return {"diagram": None}
    if want == "table":
        return {"diagram": {"kind": "table", "elements": [],
                            "table": {"caption": None, "row_labels": False,
                                      "headers": ["Person", "Form"], "rows": [["je", ""]]}}}
    return {"diagram": {"kind": "number_line", "elements": [{"kind": "point"}]}}


def fake_check(model, question, answer, attempt):
    yield "{}"
    return {"verdict": "correct" if attempt == answer else "incorrect", "feedback": "Look again."}


def failing_prerequisite(model, topic, question, verbosity):
    yield '{"summ'
    raise llm.ModelFailed("The model stopped partway. Try again.")


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        llm.generate = fake_generate
        llm.prerequisite = failing_prerequisite
        llm.diagram = fake_diagram
        llm.check = fake_check
        app.REPORTS_FILE = Path(tempfile.mkdtemp()) / "reports.jsonl"
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def setUp(self):
        app.limiter = app.HourlyLimiter()

    def call(self, path, body=None, install="test-install-0000001", founder=None):
        headers = {"X-PracticeX-Install": install, "Origin": "chrome-extension://abc"}
        if founder:
            headers["X-PracticeX-Founder"] = founder
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req) as res:
                if res.headers["Content-Type"] == "application/x-ndjson":
                    events = [json.loads(line) for line in res.read().decode().splitlines()]
                    done = next((e["result"] for e in events if e["type"] == "done"), {})
                    return res.status, {**done, "usage": events[0]["usage"], "events": events}, res.headers
                return res.status, json.loads(res.read()), res.headers
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read()), e.headers

    def test_config_lists_only_gpt_models(self):
        status, data, headers = self.call("/v1/config")
        self.assertEqual(status, 200)
        ids = [m["id"] for m in data["models"]]
        self.assertEqual(ids, ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"])  # Astra is founder-only
        self.assertEqual(data["default_model"], "gpt-5.6-luna")
        self.assertEqual(data["usage"], {"used": 0, "limit": 3, "resets_at": None})
        self.assertEqual(headers["Access-Control-Allow-Origin"], "chrome-extension://abc")

    def test_difficulty_is_a_level_and_old_words_still_work(self):
        for sent, expected in [(0, 0), (73, 73), (100, 100), (140, 100), (-3, 0),
                               ("easier", 25), ("same", 50), ("harder", 75), ("junk", 50), (None, 50)]:
            app.limiter = app.HourlyLimiter()  # more cases here than the test cap allows
            _, data, _ = self.call(
                "/v1/generate", {"image": IMAGE, "media_type": "image/jpeg", "difficulty": sent}
            )
            self.assertEqual(data["difficulty"], expected, sent)

    def test_health_needs_no_install_id(self):
        req = urllib.request.Request(self.base + "/healthz")
        with urllib.request.urlopen(req) as res:
            self.assertEqual(json.loads(res.read())["ok"], True)

    def test_cors_only_for_the_named_extension_when_one_is_set(self):
        app.ALLOWED_EXTENSION_IDS = {"abc"}
        try:
            _, _, headers = self.call("/v1/config")  # Origin: chrome-extension://abc
            self.assertEqual(headers["Access-Control-Allow-Origin"], "chrome-extension://abc")
            req = urllib.request.Request(
                self.base + "/v1/config",
                headers={"X-PracticeX-Install": "test-install-0000001", "Origin": "chrome-extension://other"},
            )
            with urllib.request.urlopen(req) as res:
                self.assertIsNone(res.headers["Access-Control-Allow-Origin"])
        finally:
            app.ALLOWED_EXTENSION_IDS = set()

    def test_config_founder(self):
        _, data, _ = self.call("/v1/config", founder="founder-secret")
        self.assertTrue(data["founder"])
        self.assertEqual(data["default_model"], "gpt-6-astra")
        self.assertIn("gpt-6-astra", [m["id"] for m in data["models"]])
        _, data, _ = self.call("/v1/config", founder="wrong")
        self.assertFalse(data["founder"])

    def test_picks_requested_gpt_model_and_rejects_others(self):
        _, data, _ = self.call("/v1/generate", {"image": IMAGE, "media_type": "image/jpeg", "model": "gpt-5.6-sol"})
        self.assertEqual(data["model"], "gpt-5.6-sol")
        _, data, _ = self.call("/v1/generate", {"image": IMAGE, "media_type": "image/jpeg", "model": "some-other-vendor-model"})
        self.assertEqual(data["model"], "gpt-5.6-luna")
        _, data, _ = self.call("/v1/generate", {"image": IMAGE, "media_type": "image/jpeg", "model": "gpt-6-astra"})
        self.assertEqual(data["model"], "gpt-5.6-luna")  # founder-only model asked for without a token

    def test_problem_count_is_passed_and_clamped(self):
        for sent, expected in [(1, 1), (5, 5), (6, 3), (0, 3), ("5", 3), (True, 3)]:
            _, data, _ = self.call("/v1/generate", {"image": IMAGE, "media_type": "image/jpeg", "count": sent})
            self.assertEqual(data["count"], expected, sent)
            app.limiter = app.HourlyLimiter()

    def test_verbosity_is_passed_and_validated(self):
        for sent, expected in [("brief", "brief"), ("detailed", "detailed"), ("novel", "standard"), (None, "standard")]:
            _, data, _ = self.call("/v1/generate", {"image": IMAGE, "media_type": "image/jpeg", "verbosity": sent})
            self.assertEqual(data["verbosity"], expected, sent)
            app.limiter = app.HourlyLimiter()

    def test_diagram_on_request(self):
        status, data, _ = self.call("/v1/diagram", {"question": "Solve x + 1 < 3"})
        self.assertEqual(status, 200)
        self.assertEqual(data["diagram"]["kind"], "number_line")
        self.assertEqual(data["usage"]["used"], 1)
        status, data, _ = self.call("/v1/diagram", {"question": "impossible"})
        self.assertEqual(status, 502)
        status, _, _ = self.call("/v1/diagram", {"question": ""})
        self.assertEqual(status, 400)

    def test_check_answer(self):
        status, data, _ = self.call("/v1/check", {"question": "Solve", "answer": "4", "attempt": " 4 "})
        self.assertEqual((status, data["verdict"], data["usage"]["used"]), (200, "correct", 1))
        _, data, _ = self.call("/v1/check", {"question": "Solve", "answer": "4", "attempt": "5"})
        self.assertEqual(data["verdict"], "incorrect")
        status, _, _ = self.call("/v1/check", {"question": "Solve", "answer": "4", "attempt": "   "})
        self.assertEqual(status, 400)

    def test_answer_format(self):
        for sent, expected in [("multiple_choice", "multiple_choice"), ("free", "free"), ("mixed", "mixed"),
                               ("auto", "auto"), ("quiz", "auto"), (None, "auto")]:
            _, data, _ = self.call("/v1/generate", {"image": IMAGE, "media_type": "image/jpeg", "answer_format": sent})
            self.assertEqual(data["answer_format"], expected, sent)
            app.limiter = app.HourlyLimiter()

    def test_multiple_choice_shaping(self):
        def shaped(fmt, options, correct):
            data = {"readable": True, "subject": "math", "topic": "t",
                    "problems": [{"question": "q", "answer": "6", "diagram_useful": False,
                                  "options": options, "correct_option": correct}]}
            p = llm.shape_generated(data, 3, fmt)["problems"][0]
            return p["options"], p["correct_option"]
        self.assertEqual(shaped("multiple_choice", ["4", "5", "6", "7"], 2), (["4", "5", "6", "7"], 2))
        # A written-answer set never carries options, and unusable options fall back to a written answer.
        self.assertEqual(shaped("free", ["4", "5", "6", "7"], 2), ([], None))
        self.assertEqual(shaped("multiple_choice", ["9"], 0), ([], None))
        self.assertEqual(shaped("multiple_choice", ["8", "9"], 5), ([], None))
        self.assertEqual(shaped("multiple_choice", ["8", "9"], True), ([], None))
        # A mixed set keeps the options the model supplied and writes out the ones it left bare.
        self.assertEqual(shaped("mixed", ["4", "5", "6", "7"], 2), (["4", "5", "6", "7"], 2))
        self.assertEqual(shaped("mixed", [], None), ([], None))

    def test_answer_mix_share(self):
        for mix, expected in [(0, 99), (25, 75), (50, 50), (100, 1)]:
            self.assertIn(f"{expected}%", llm.format_rule("mixed", mix))
        self.assertNotIn("{share}", llm.format_rule("free", 50))

    def test_diagram_rules_by_subject(self):
        fig = {"kind": "geometry", "x_min": 0, "x_max": 1, "y_min": 0, "y_max": 1,
               "elements": [{"kind": "point", "points": [[0.5, 0.5]]}]}
        def shaped(subject, useful):
            data = {"readable": True, "subject": subject, "topic": "t",
                    "problems": [{"question": "q", "answer": "a", "diagram_useful": useful, "diagram": fig}]}
            return llm.shape_generated(data, 3)
        self.assertIsNotNone(shaped("math", True)["problems"][0]["diagram"])
        # The model said no (e.g. simple addition): the figure it sent anyway is dropped.
        self.assertEqual(shaped("math", False)["problems"][0], {**shaped("math", False)["problems"][0], "diagram_useful": False, "diagram": None})
        for subject in ("writing", "language", "history"):
            p = shaped(subject, True)["problems"][0]
            self.assertEqual((p["diagram_useful"], p["diagram"]), (False, None), subject)
        self.assertEqual(shaped("astrology", True)["subject"], "other")
        status, _, _ = self.call("/v1/diagram", {"question": "Fix the comma", "subject": "writing"})
        self.assertEqual(status, 400)

    def test_diagram_cleaning(self):
        self.assertIsNone(llm._clean_diagram(None))
        self.assertIsNone(llm._clean_diagram({"x_min": 1, "x_max": 0, "y_min": 0, "y_max": 1, "elements": []}))
        d = llm._clean_diagram({
            "kind": "evil", "x_min": 0, "x_max": 4, "y_min": 0, "y_max": 4, "show_grid": True, "x_label": None, "y_label": None,
            "elements": [{"kind": "vector", "points": [[0, 0], [1, float("nan")], [2, 2], "x"], "radius": -1, "label": "u" * 99, "emphasis": "loud", "dashed": 0}],
        })
        self.assertEqual(d["kind"], "geometry")
        self.assertEqual(d["elements"][0]["points"], [[0.0, 0.0], [2.0, 2.0]])
        self.assertIsNone(d["elements"][0]["radius"])
        self.assertEqual(len(d["elements"][0]["label"]), 40)
        self.assertEqual(d["elements"][0]["emphasis"], "main")

    def test_3d_diagram_cleaning(self):
        base = {"kind": "space_3d", "x_min": -2, "x_max": 2, "y_min": -2, "y_max": 2, "z_min": 0, "z_max": 4}
        grid = [[x, y, x * x + y * y] for x in range(3) for y in range(3)]
        d = llm._clean_diagram({**base, "elements": [
            {"kind": "vector", "points": [[0, 0, 0], [1, 2, 3]], "label": "u"},
            {"kind": "surface", "points": grid + [[0, 0, 0]], "grid_cols": 3},  # stray point trimmed
            {"kind": "surface", "points": grid, "grid_cols": 1},  # not a grid
            {"kind": "angle", "points": [[0, 0, 0]] * 3},  # 2D only
            {"kind": "point", "points": [[1, 2]]},  # flat point in a 3D figure
        ]})
        self.assertEqual([(e["kind"], len(e["points"]), e["grid_cols"]) for e in d["elements"]],
                         [("vector", 2, None), ("surface", 9, 3)])
        self.assertEqual(d["z_max"], 4.0)
        self.assertIsNone(llm._clean_diagram({**base, "z_min": None, "elements": [{"kind": "point", "points": [[0, 0, 0]]}]}))
        flat = llm._clean_diagram({"kind": "geometry", "x_min": 0, "x_max": 1, "y_min": 0, "y_max": 1, "z_min": 3,
                                   "elements": [{"kind": "point", "points": [[0.5, 0.5]], "grid_cols": 4}]})
        self.assertIsNone(flat["z_min"])
        self.assertIsNone(flat["elements"][0]["grid_cols"])

    def test_table_cleaning(self):
        base = {"kind": "table", "x_min": 0, "x_max": 0, "y_min": 0, "y_max": 0, "elements": []}
        d = llm._clean_diagram({**base, "essential": True, "table": {
            "caption": "Value table", "row_labels": True,
            "headers": ["x", "f(x)", "  spare  "],
            "rows": [["-1", "", "a"], ["0", ""], [], ["2", "c" * 300, "d"]],
        }})
        self.assertEqual(d["kind"], "table")
        self.assertIsNone(d["x_min"])  # a table has no bounds to fail on
        self.assertEqual(d["table"]["headers"], ["x", "f(x)", "spare"])
        self.assertEqual([len(r) for r in d["table"]["rows"]], [3, 3, 3])  # short row padded, empty row gone
        self.assertEqual(d["table"]["rows"][1], ["0", "", ""])
        self.assertEqual(len(d["table"]["rows"][2][1]), llm.MAX_CELL)
        self.assertTrue(d["table"]["row_labels"])
        # Nothing usable.
        self.assertIsNone(llm._clean_diagram({**base, "table": None}))
        self.assertIsNone(llm._clean_diagram({**base, "table": {"headers": ["only"], "rows": [["a"]]}}))
        self.assertIsNone(llm._clean_diagram({**base, "table": {"headers": ["a", "b"], "rows": []}}))
        self.assertIsNone(llm._clean_diagram({**base, "table": {"headers": ["a", "b"], "rows": [["", ""]]}}))
        # Caps.
        wide = llm._clean_diagram({**base, "table": {
            "headers": [str(k) for k in range(20)], "rows": [[str(k) for k in range(20)]] * 40}})
        self.assertEqual(len(wide["table"]["headers"]), llm.MAX_TABLE_COLS)
        self.assertEqual(len(wide["table"]["rows"]), llm.MAX_TABLE_ROWS)
        # A drawn figure still carries the key, empty.
        drawn = llm._clean_diagram({"kind": "geometry", "x_min": 0, "x_max": 1, "y_min": 0, "y_max": 1,
                                    "elements": [{"kind": "point", "points": [[0.5, 0.5]]}]})
        self.assertIsNone(drawn["table"])

    def test_tables_are_allowed_where_drawings_are_not(self):
        table = {"kind": "table", "essential": False, "elements": [], "table": {
            "caption": None, "row_labels": False, "headers": ["Tense", "Form"], "rows": [["present", ""]]}}
        drawing = {"kind": "geometry", "x_min": 0, "x_max": 1, "y_min": 0, "y_max": 1,
                   "elements": [{"kind": "point", "points": [[0.5, 0.5]]}]}

        def shaped(subject, kind, fig):
            data = {"readable": True, "subject": subject, "topic": "t", "problems": [
                {"question": "q", "answer": "a", "diagram_useful": True, "figure_kind": kind, "diagram": fig}]}
            return llm.shape_generated(data, 1)["problems"][0]

        for subject in ("writing", "language", "history"):
            p = shaped(subject, "table", table)
            self.assertEqual((p["diagram_useful"], p["figure_kind"], p["diagram"]["kind"]),
                             (True, "table", "table"), subject)
            # A drawing is still refused there, even when the model mislabels it as a table.
            self.assertIsNone(shaped(subject, "drawing", drawing)["diagram"], subject)
            self.assertIsNone(shaped(subject, "table", drawing)["diagram"], subject)
        self.assertEqual(shaped("chemistry", "table", table)["diagram"]["kind"], "table")
        self.assertEqual(shaped("math", "drawing", drawing)["diagram"]["kind"], "geometry")
        # The endpoint follows the same rule: a table request is fine for writing, a drawing is not.
        status, _, _ = self.call("/v1/diagram", {"question": "Conjugate parler", "subject": "language", "want": "table"})
        self.assertNotEqual(status, 400)
        status, _, _ = self.call("/v1/diagram", {"question": "Fix the comma", "subject": "writing"})
        self.assertEqual(status, 400)

    def test_rejects_missing_install_and_bad_image(self):
        status, _, _ = self.call("/v1/config", install="x")
        self.assertEqual(status, 400)
        status, data, _ = self.call("/v1/generate", {"image": "not base64!!", "media_type": "image/jpeg"})
        self.assertEqual(status, 400)
        status, _, _ = self.call("/v1/generate", {"image": IMAGE, "media_type": "image/gif"})
        self.assertEqual(status, 400)

    def test_hourly_cap(self):
        for i in range(3):
            status, data, _ = self.call("/v1/generate", {"image": IMAGE, "media_type": "image/jpeg"})
            self.assertEqual(status, 200)
            self.assertEqual(data["usage"]["used"], i + 1)
        status, data, _ = self.call("/v1/generate", {"image": IMAGE, "media_type": "image/jpeg"})
        self.assertEqual(status, 429)
        self.assertIn("resets_at", data)
        # Invalid requests do not spend the cap.
        app.limiter = app.HourlyLimiter()
        self.call("/v1/generate", {"image": IMAGE, "media_type": "image/gif"})
        _, data, _ = self.call("/v1/config")
        self.assertEqual(data["usage"]["used"], 0)

    def test_ip_cap_stops_install_id_rotation(self):
        codes = [
            self.call("/v1/generate", {"image": IMAGE, "media_type": "image/jpeg"}, install=f"rotating-install-{i:04d}")[0]
            for i in range(10)
        ]
        self.assertEqual(codes.count(200), app.IP_HOURLY_CAP)

    def test_generate_streams_deltas_then_done(self):
        _, data, _ = self.call("/v1/generate", {"image": IMAGE, "media_type": "image/jpeg"})
        types = [e["type"] for e in data["events"]]
        self.assertEqual(types, ["meta", "delta", "delta", "done"])
        self.assertEqual("".join(e["text"] for e in data["events"] if e["type"] == "delta"), '{"readable": true}')

    def test_model_failure_mid_stream_becomes_error_event(self):
        _, data, _ = self.call("/v1/prerequisite", {"question": "Solve"})
        self.assertEqual(data["events"][-1], {"type": "error", "error": "The model stopped partway. Try again."})

    def test_report_is_logged(self):
        status, _, _ = self.call("/v1/report", {"reason": "answer", "question": "Q", "answer": "A", "steps": ["s"]})
        self.assertEqual(status, 200)
        record = json.loads(app.REPORTS_FILE.read_text().splitlines()[-1])
        self.assertEqual(record["reason"], "answer")

    def test_reports_are_capped_without_spending_the_hourly_cap(self):
        body = {"reason": "answer", "question": "Q", "answer": "A", "steps": []}
        codes = [self.call("/v1/report", body)[0] for _ in range(app.REPORT_HOURLY_CAP + 2)]
        self.assertEqual(codes.count(200), app.REPORT_HOURLY_CAP)
        self.assertEqual(codes[-1], 429)
        _, data, _ = self.call("/v1/config")
        self.assertEqual(data["usage"]["used"], 0)


if __name__ == "__main__":
    unittest.main()
