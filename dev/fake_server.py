"""Runs the real server with canned model output, for UI work without spending API credit.
Run from the repo root: server/.venv/bin/python dev/fake_server.py"""

import json
import sys
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import os  # noqa: E402

os.environ.setdefault("OPENAI_API_KEY", "fake")
import app  # noqa: E402
import llm  # noqa: E402


def el(kind, points, label=None, emphasis="main", radius=None, dashed=False):
    return {"kind": kind, "points": points, "radius": radius, "label": label, "emphasis": emphasis, "dashed": dashed}


PARABOLA = [[x / 10, (x / 10) ** 2 - 2 * (x / 10) - 3] for x in range(-20, 41)]

PROBLEMS = [
    {
        "question": r"Given \(\mathbf{a} = \langle 3, -1 \rangle\) and \(\mathbf{b} = \langle -2, 2 \rangle\), find \(\mathbf{a} + \mathbf{b}\) and describe where it points.",
        "diagram": {"kind": "coordinate_plane", "x_min": -3, "x_max": 4, "y_min": -2, "y_max": 3, "show_grid": True, "x_label": "x", "y_label": "y",
                    "elements": [el("vector", [[0, 0], [3, -1]], "a"), el("vector", [[0, 0], [-2, 2]], "b", "secondary")]},
        "answer": r"\(\mathbf{a} + \mathbf{b} = \langle 1, 1 \rangle\), pointing up and to the right at \(45^\circ\).",
        "approach": r"Vectors in component form add component by component. The rule is \[\langle a_1, a_2 \rangle + \langle b_1, b_2 \rangle = \langle a_1 + b_1,\; a_2 + b_2 \rangle.\] Horizontal parts only combine with horizontal parts, and vertical with vertical, because they measure movement along different axes.",
        "steps": [
            r"Write down the two vectors and label which entry is which. The first entry is the horizontal component and the second is the vertical component. \[\mathbf{a} = \langle 3, -1 \rangle, \qquad \mathbf{b} = \langle -2, 2 \rangle\]",
            r"Apply the component rule, lining up matching entries. \[\mathbf{a} + \mathbf{b} = \langle 3 + (-2),\; -1 + 2 \rangle\]",
            r"Add the horizontal components. Adding \(-2\) is the same as subtracting \(2\). \[3 + (-2) = 1\]",
            r"Add the vertical components. \[-1 + 2 = 1\]",
            r"Put the two results back in order. \[\mathbf{a} + \mathbf{b} = \langle 1, 1 \rangle\]",
            r"Describe the direction. Both components are positive and equal, so the vector points into the first quadrant along the line \(y = x\), which makes an angle of \(45^\circ\) with the positive \(x\)-axis: \[\theta = \tan^{-1}\!\left(\frac{1}{1}\right) = 45^\circ\]",
        ],
        "check": r"Walk it tip to tail: start at the origin, follow \(\mathbf{a}\) to \((3, -1)\), then follow \(\mathbf{b}\) by moving \(2\) left and \(2\) up to reach \((1, 1)\). That endpoint matches \(\langle 1, 1 \rangle\).",
        "common_mistake": r"Adding the first entry of one vector to the second entry of the other, or dropping the negative sign on \(-2\). Line the vectors up vertically before adding so the matching entries sit on top of each other.",
    },
    {
        "question": r"Solve and graph on a number line: \(3x - 5 < 7\).",
        "diagram": {"kind": "number_line", "x_min": -2, "x_max": 8, "y_min": -1, "y_max": 1, "show_grid": False, "x_label": None, "y_label": None,
                    "elements": [el("point", [[0, 0]], "0", "secondary")]},
        "answer": r"\(x < 4\)",
        "approach": r"A linear inequality is solved like an equation: undo operations in reverse order. The one extra rule is that multiplying or dividing by a negative flips the sign, which does not happen here.",
        "steps": [r"Add \(5\) to both sides. \[3x < 12\]", r"Divide both sides by \(3\), a positive number, so the sign stays. \[x < 4\]"],
        "check": r"Try \(x = 0\): \(3(0) - 5 = -5 < 7\), true. Try \(x = 5\): \(10 < 7\), false. So values below \(4\) work.",
        "common_mistake": r"Drawing a filled dot at \(4\). The inequality is strict, so \(4\) itself is not included and the dot is open.",
    },
    {
        "question": r"In triangle \(ABC\), \(\angle A = 52^\circ\) and \(\angle B = 71^\circ\). Find \(\angle C\).",
        "diagram": {"kind": "geometry", "x_min": -0.5, "x_max": 6.5, "y_min": -0.6, "y_max": 4.6, "show_grid": False, "x_label": None, "y_label": None,
                    "elements": [el("polygon", [[0, 0], [6, 0], [2.4, 4]]), el("angle", [[6, 0], [0, 0], [2.4, 4]], "52°", "secondary"),
                                 el("angle", [[2.4, 4], [6, 0], [0, 0]], "71°", "secondary"), el("text", [[-0.3, -0.35]], "A"),
                                 el("text", [[6.3, -0.35]], "B"), el("text", [[2.4, 4.35]], "C")]},
        "answer": r"\(\angle C = 57^\circ\)",
        "approach": r"The angles of any triangle add to \(180^\circ\).",
        "steps": [r"\[\angle A + \angle B + \angle C = 180^\circ\]", r"\[52^\circ + 71^\circ + \angle C = 180^\circ\]", r"\[\angle C = 57^\circ\]"],
        "check": r"\(52 + 71 + 57 = 180\).",
        "common_mistake": r"Subtracting only one angle from \(180^\circ\).",
    },
    {
        "question": r"The graph of \(f(x) = x^2 - 2x - 3\) is shown. Find its \(x\)-intercepts and vertex.",
        "diagram": {"kind": "coordinate_plane", "essential": True, "x_min": -3, "x_max": 5, "y_min": -5, "y_max": 6, "show_grid": True, "x_label": "x", "y_label": "y",
                    "elements": [el("curve", PARABOLA, "y = f(x)")]},
        "answer": r"Intercepts \((-1, 0)\) and \((3, 0)\); vertex \((1, -4)\).",
        "approach": r"Factor to find the zeros; the vertex sits halfway between them.",
        "steps": [r"\[x^2 - 2x - 3 = (x - 3)(x + 1) = 0\]", r"\[x = 3 \quad\text{or}\quad x = -1\]", r"\[x_v = \frac{3 + (-1)}{2} = 1, \qquad f(1) = 1 - 2 - 3 = -4\]"],
        "check": r"\(f(3) = 9 - 6 - 3 = 0\) and \(f(-1) = 1 + 2 - 3 = 0\).",
        "common_mistake": r"Sign errors when factoring: \((x + 3)(x - 1)\) expands to \(x^2 + 2x - 3\), not the given function.",
    },
    {
        "question": r"Simplify \(\dfrac{6x^2 - 24}{3x + 6}\), and state any restriction on \(x\).",
        "diagram": None,
        "answer": r"\(2(x - 2)\), with \(x \neq -2\).",
        "approach": r"Factor the numerator and denominator fully, then cancel common factors.",
        "steps": [r"\[6x^2 - 24 = 6(x^2 - 4) = 6(x - 2)(x + 2)\]", r"\[3x + 6 = 3(x + 2)\]", r"\[\frac{6(x - 2)(x + 2)}{3(x + 2)} = 2(x - 2), \quad x \neq -2\]"],
        "check": r"At \(x = 0\): \(\frac{-24}{6} = -4\) and \(2(0 - 2) = -4\).",
        "common_mistake": r"Forgetting the restriction \(x \neq -2\) after cancelling.",
    },
]


def _type_out(value, chars=24, delay=0.03):
    """Streams the JSON of `value` a few characters at a time, like a model would."""
    text = json.dumps(value)
    for i in range(0, len(text), chars):
        time.sleep(delay)
        yield text[i:i + chars]


def _titled(step):
    """Canned steps are plain strings; split them into the title/detail shape the model now returns."""
    head, sep, rest = step.partition(". ")
    if sep and not head.startswith("\\"):
        return {"title": head, "detail": rest}
    return {"title": "Work it through", "detail": step}


def generate(model, image, media_type, difficulty, count, verbosity="standard"):
    time.sleep(1.0)  # "reading the problem"
    problems = [{**p, "steps": [_titled(s) for s in p["steps"]]} for p in PROBLEMS[:count]]
    data = {"readable": True, "topic": "Mixed practice", "problems": problems}
    yield from _type_out(data)
    return {**data, "problems": [{**p, "diagram": llm._clean_diagram(p["diagram"])} for p in data["problems"]]}


def el3(kind, points, label=None, emphasis="main", radius=None, grid_cols=None, dashed=False):
    return {"kind": kind, "points": points, "radius": radius, "grid_cols": grid_cols, "label": label,
            "emphasis": emphasis, "dashed": dashed}


def _space(x, y, z, elements):
    return {"kind": "space_3d", "essential": False, "x_min": x[0], "x_max": x[1], "y_min": y[0], "y_max": y[1],
            "z_min": z[0], "z_max": z[1], "show_grid": False, "x_label": None, "y_label": None, "z_label": None,
            "elements": elements}


CUBE = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0], [0, 0, 2], [2, 0, 2], [2, 2, 2], [0, 2, 2]]
SAMPLES_3D = [
    # two vectors and the plane they span
    _space((-1, 3), (-1, 3), (-1, 3), [
        el3("polygon", [[-0.5, -0.5, -0.25], [2.5, -0.5, 1.25], [2.5, 2.5, 2.75], [-0.5, 2.5, 1.25]], "P", "faint"),
        el3("vector", [[0, 0, 0], [2, 0, 1]], "u"),
        el3("vector", [[0, 0, 0], [0, 2, 1]], "v", "secondary"),
        el3("point", [[0, 0, 0]], "O", "secondary"),
    ]),
    # paraboloid z = x^2 + y^2
    _space((-2, 2), (-2, 2), (0, 8), [
        el3("surface", [[x / 2, y / 2, (x / 2) ** 2 + (y / 2) ** 2] for x in range(-4, 5) for y in range(-4, 5)],
            "z = x² + y²", grid_cols=9),
    ]),
    # a cube with a space diagonal
    _space((-0.5, 2.5), (-0.5, 2.5), (-0.5, 2.5), [
        *[el3("polygon", [CUBE[i] for i in face], emphasis="secondary")
          for face in ([0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4])],
        el3("segment", [CUBE[0], CUBE[6]], "d", dashed=True),
        el3("point", [CUBE[0]], "A"), el3("point", [CUBE[6]], "G"),
    ]),
]
_made = [0]


def diagram(model, topic, question):
    time.sleep(1.2)
    yield "{}"
    sample = SAMPLES_3D[_made[0] % len(SAMPLES_3D)]
    _made[0] += 1
    return {"diagram": llm._clean_diagram(sample)}


def check(model, question, answer, attempt):
    """Rough stand-in for the model: compares the numbers in the answer with the numbers typed."""
    import re
    time.sleep(0.8)
    yield "{}"
    want = re.findall(r"-?\d+", answer.replace("−", "-"))
    got = re.findall(r"-?\d+", attempt.replace("−", "-"))
    if want and sorted(want) == sorted(got):
        return {"verdict": "correct", "feedback": "Both components are right."}
    if set(want) & set(got):
        return {"verdict": "partly", "feedback": "One part is right; look again at the signs in the other."}
    return {"verdict": "incorrect", "feedback": "Add the matching components of the two vectors."}


def prerequisite(model, topic, question, verbosity="standard"):
    data = {
        "summary": r"Adding vectors depends on reading components and on signed arithmetic.",
        "prerequisites": [
            {"name": "Component form", "explanation": r"A vector \(\langle a, b \rangle\) means move \(a\) across and \(b\) up.\n\nFor example \(\langle 3, -1 \rangle\) is three right, one down."},
            {"name": "Adding negative numbers", "explanation": r"Adding a negative is subtracting: \[3 + (-2) = 3 - 2 = 1\]"},
        ],
        "video_searches": ["adding vectors component form", "adding negative numbers"],
    }
    time.sleep(0.5)
    yield from _type_out(data)
    return data


llm.generate = generate
llm.prerequisite = prerequisite
llm.diagram = diagram
llm.check = check
print(f"fake StudyX server on http://localhost:{app.PORT}")
ThreadingHTTPServer(("127.0.0.1", app.PORT), app.Handler).serve_forever()
