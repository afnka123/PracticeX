# PracticeX

A Chrome extension that reads the question on the student's screen and writes new practice problems of the
same type: math, science, writing and languages. It does not solve homework; it makes more of it.

```
extension/   the Chrome extension (Manifest V3, side panel). Load this folder unpacked.
server/      the backend. Holds the API keys and enforces the hourly cap.
dev/         a fake-model server and a popup preview page, for UI work without an API key.
render.yaml  the Render blueprint for deploying server/.
brand/       the unzipped brand kit (reference only, not shipped).
```

## Run it

1. Start the server:

   ```bash
   cd server
   python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
   cp .env.example .env        # then set OPENAI_API_KEY
   .venv/bin/python app.py     # http://localhost:8787
   ```

2. Load the extension: open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and
   pick the `extension/` folder.

3. Open a page with a math problem, click the PracticeX icon to open the side panel, then **Generate**.
   The first time, Chrome asks for permission to read pages. PracticeX needs it to take the screenshot.

For founder use (higher hourly cap, GPT-6 Astra as the default), set `FOUNDER_TOKEN` in `server/.env` and
paste the same value into the popup's Settings (gear icon).

The Model, Server and Founder token fields appear only in unpacked builds (no `update_url` in the manifest),
under Settings > Developer. Students on a Web Store build never see them and get the server's default model.

## Deploy the server to Render

`render.yaml` in the repo root describes the service, so Render can create it from the repo:

1. Push this repo to GitHub, then in Render choose **New > Blueprint** and pick it. It reads
   `render.yaml`: Python service, root `server/`, build `pip install -r requirements.txt`, start
   `python app.py`, health check `/healthz`.
2. Set the three secrets in the dashboard (they are marked `sync: false`, so they are never in the repo):
   - `OPENAI_API_KEY` — the same key as in `server/.env`.
   - `FOUNDER_TOKEN` — any long random string, for your own higher cap.
   - `ALLOWED_EXTENSION_IDS` — the packed extension's id from `chrome://extensions`. With it set, only
     that extension gets CORS headers, so a random page cannot spend your quota. Leave it unset until the
     extension is packed, then add it.
3. Render supplies `PORT`; the blueprint sets `HOST=0.0.0.0` so the server listens on it, and
   `TRUST_PROXY=1` so the per-IP cap reads `X-Forwarded-For` instead of Render's proxy address.
4. Point the extension at it: set `PROD_SERVER` at the top of `extension/panel.js` to the service URL
   (`https://<name>.onrender.com`). Packed builds always use it; unpacked builds keep using localhost and
   can still be redirected in Settings > Developer.

Two things to know about the free plan: the service sleeps when idle, so the first request after a quiet
spell takes about a minute, and every restart clears the in-memory rate limits. Both are fine for a pilot.
Before real traffic, move the limiter to Redis and put reports somewhere that survives a restart:
`REPORTS_FILE` can point at a mounted Render disk, since the default filesystem is wiped on every deploy.
Set a monthly spending limit on the API key in the OpenAI dashboard as well; the server cannot protect a
leaked key.

## How it works

- **Its own window.** The toolbar icon opens PracticeX in a small window (460x700 by default) near the top
  right of the browser window, not in Chrome's side panel, so it does not run the full height of the screen.
  It floats over any tab, survives tab switches, and can be moved and resized; `background.js` remembers
  where it was left and reopens it there. Clicking the icon again brings the open window back to the front
  instead of making a second one. The focus button (four corners) makes that window fullscreen and back;
  the roomier layout with larger type turns on by window width (860px and up), however the window got
  that big.
- **Screenshot first.** Generate captures the visible tab of the last focused browser window. That needs the
  `<all_urls>` host permission, which is optional and requested on the first click.
- **Crop in a big window.** The panel window is too narrow to select comfortably, so the screenshot opens
  in a window that fills 94% of the screen (`panel.html?crop=1`). The student drags a box over the problem
  and presses Generate (or Enter). The window sends the cropped image
  back to the panel through `chrome.storage.session` and closes. Only the selected part is sent, which keeps
  names, emails and other tabs' content off the network. A fullscreen panel crops in place.
- **Streaming.** `/v1/generate` and `/v1/prerequisite` send newline-delimited JSON events as the model
  writes: `meta` (usage), then `delta` pieces of the model's JSON, then `done` (the server-validated result)
  or `error`. `extension/partial-json.js` parses the unfinished JSON, and the panel fills in each field as
  it grows, with a caret where it is still typing. A formula is held back until its closing delimiter
  arrives, so raw LaTeX never flashes. Reveal unlocks as soon as that problem's answer is complete, while
  later problems are still being written. If the student closes the panel mid-stream, the server stops
  the model call.
- **Difficulty slider.** Continuous, 0 to 100, green at the easy end through amber to deep red at the hard
  one. The handle's ring and the word above it take the color of wherever it lands, and the nearest of the
  Easy / Medium / Hard marks lights up. The panel names five bands (Very easy, Easy, Medium, Hard, Very
  hard) and the server turns the same number into five graded instructions, from "small whole numbers, one
  or two steps" to "two extra steps, awkward numbers, or a twist". Everything is relative to the question on
  screen, which the slider's tooltip says ("The same level as the question you screenshot"). The old
  `easier` / `same` / `harder` strings still work and land on 25 / 50 / 75, so sets saved before the slider
  reopen at the right spot. **More like these** moves the slider 25 either way instead of jumping to a fixed
  step.
- **1 to 5 problems per set.** Chosen with the Problems slider. One request returns every problem with its
  answer and a full worked solution: approach, titled steps, a check, and the common mistake. The student
  sees the answer only after clicking View answer, and the worked solution only after Show work.
- **Answers** (start screen): Written or Choices (multiple choice), saved between sessions and sent with the
  request. Multiple choice asks for exactly 4 options per question with one correct, the correct one in a
  different position across the set, and wrong options that are the usual mistakes. The panel then replaces
  the typing box with A-D buttons: clicking one answers it, checked locally with no request. A wrong pick
  is marked and disabled so the student can try again; the right one flashes green and reveals the answer.
  The server drops options that do not form a usable set (fewer than two, or a correct index out of range)
  and that question falls back to a written answer.
- **Check answer.** Appears once the student types in the answer box, with View answer next to it. Enter
  also checks. Each problem arrives with `accepted_answers`, 4 to 10 plain-text ways to type the same answer
  that the model writes along with it (½ as 1/2 or 0.5, roots in either order, with or without "x ="). An
  answer matching one of these, or a single number equal in value, is marked correct locally, with no
  request. Anything else goes to `/v1/check`, where the model judges it correct, partly or incorrect. Equivalent
  forms count as correct: 0.5 vs ½, roots in any order. The model gives a one-line hint that never states
  the answer. The check counts as one request toward the hourly cap. When correct, a light-green (#A8E6A1)
  band sweeps across the answer and the box glows for about 3 seconds; then the answer and Show work
  appear. Editing the answer clears an old result. Each step shows
  only its title; click it (or **Open all**) to read the explanation.
- **Verbosity** (Settings): Brief, Standard or Detailed. It is sent with each request and controls how many
  steps there are and how much each one explains. In a real test with GPT-5.6 Luna, Brief gave 3 short steps
  and Detailed gave 6 steps averaging about 260 characters each.
  **More like these** reuses the last screenshot, so no new capture is needed.
- **Math rendering.** The model writes LaTeX. MathJax 3.2.2 (`extension/vendor/mathjax`, Apache 2.0) renders it
  as SVG. It is bundled because extensions cannot load remote scripts. TeX's `\href`, `\require` and
  autoloading are switched off because model output is untrusted. Problem text uses STIX Two Text, so it reads
  apart from the interface. The text size slider in Settings scales it from 85% to 180%.
- **Subject and diagrams.** The model labels each set's `subject` (math, physics, chemistry, biology,
  other_science, writing, language, history, other) and marks every question with `diagram_useful`. A
  diagram button, including **Make me a diagram**, appears only where that flag is true: never for writing,
  language or history, and not for simple arithmetic or routine symbol pushing. The server enforces this in
  `shape_generated`, so a figure sent against the rules is dropped, and `/v1/diagram` refuses those subjects.
  Where a figure does help, the model returns a small drawing spec rather than SVG: vectors, points,
  segments, lines, rays, polygons, circles, curves, angles and number lines. `extension/diagram.js`
  validates and draws it, with the same checks as the server's `_clean_diagram`. Every label is set as
  text, never HTML. The prompt forbids drawing the answer.
- **Working the figure.** Flat figures zoom (the + and − buttons, a trackpad pinch, or +/−/0 on the
  keyboard) up to 6x, and pan by dragging once zoomed; double-click resets. Marked points, corners, ends
  and centers are clickable, and so is every place two pieces cross — `extension/diagram.js` solves those
  crossings itself, counting the axes as pieces, so intercepts are included. Clicking one names it under
  the figure ("vertex · (0, −2)", "crosses at about (2.56, 4.56)"). A crossing is read off the drawing, so
  it is quoted to two decimals and hedged with "about"; a point the model marked is quoted exactly.
  Everything is keyboard reachable, and the dots hold their size as you zoom.
- **A note beside the figure.** A diagram can hand over an answer that was meant to be worked out, so one
  sits next to every figure: "A figure can give away the answer. Read it to check your working, not to
  skip it." It sits in a column beside the drawing when the window is wide enough, underneath when it is
  not.
- **3D diagrams.** Every model can return a `space_3d` diagram for problems that live in three dimensions:
  vectors and cross products, lines and planes, solids, solids of revolution, and surfaces z = f(x, y).
  Points are [x, y, z]. The elements are point, vector, segment, line, ray, curve, polygon (faces and plane
  patches), sphere, and surface (a row-major grid, `grid_cols` per row, up to 30 by 30).
  `extension/diagram3d.js` draws it with no library, as an orthographic SVG sorted back to front with shaded
  faces. The student drags or uses the arrow keys to rotate it, zooms with the same controls as a flat
  figure (up to 5x), and double-clicks to reset both. Axes, ticks and
  the bounding box are drawn automatically, and overlapping labels are nudged apart.
- **Struggling?** A text-only call returns the prerequisite skills plus YouTube and Khan Academy *search*
  links. Its length follows the Verbosity setting: Brief gives 1 or 2 skills in a sentence or two each,
  Detailed gives 3 or 4 with worked examples. A saved explanation is refetched when the setting changes. Search links cannot point at a page that does not
  exist.
- **Report.** Saves the question, answer, working, model and reason to `server/reports.jsonl`. The
  screenshot is never stored. Reports have their own limit (`REPORT_HOURLY_CAP`, default 10 per install and
  3× that per IP) and do not count toward the hourly cap.
- **Classes** (start screen): the student names the classes they are taking, each with a subject (or
  "from the questions", which uses whatever the model detects). The selected class is remembered and stamped
  on every set generated while it is picked. Edit turns the chips into remove buttons; removing a class
  keeps its sets, which fall back to being filed by subject. Classes live in `chrome.storage.local`.
- **Progress and history.** Each finished set is saved in `chrome.storage.local` (the last 40, never the
  screenshot): topic, subject, class, problems, what was answered and checked. The chart icon in the header
  opens Your progress: problems solved, accuracy (right before viewing the answer), a day streak,
  Strongest / Needs work, subject folders with their topics, and recent sets. Tapping a set reopens it at the first
  unanswered question. The start screen lists the last three. Clear history asks for a second tap.
- **By subject.** Every set belongs to exactly one folder: the class it was generated under, or, with no
  class, the subject the model detected (sets from before folders existed sit under Unsorted). The list
  groups folder first, then the topics inside it. One folder is open at a time, starting with the most
  practiced; tapping a topic reopens its last set. Recent sets below shows the last six.
- **Strongest and needs work.** Read per subject across every folder, so two classes in the same subject
  count together. A subject needs 4 answered questions before it is called a strength or a weakness, and
  both lines appear only once two subjects qualify; until then the card says what is missing.

## Layout

Scrollbars are styled to match: a thin peach-to-coral thumb on a transparent track, including the one
under math that is too wide for its line.

The problem view has a progress bar you can click to jump between questions. It shows the current question,
viewed answers and correct answers. Under the answer comes the "Struggling?" card, then **More like these**
with Easier / Same level / Harder, so the student can change difficulty right when they want more (hidden
for sets reopened from history, which have no screenshot). Then Start over and Report. A bottom bar
(Previous · New screenshot · Next) stays pinned to the foot of the panel. New screenshot captures straight
away. Previous and Next keep their slots when they do not apply, so the bar never shifts.

## Cost controls (brief §7, "Cost abuse")

- The API keys live only on the server. The extension has none.
- The panel states the allowance in words under the header: "12 questions left" with "of 20 this hour",
  switching to the reset time in the last three, and "Limit reached · Resets at 4:15" at zero. At zero,
  Generate, New screenshot and More like these are disabled, so a student never spends a click on a
  request the server would refuse.
- All limits are sliding one-hour windows, enforced on the server:
  - `HOURLY_CAP`: per install, default 50.
  - `IP_HOURLY_CAP`: per IP, default 3× the per-install cap. This stops a script from rotating install
    ids.
  - `GLOBAL_HOURLY_CAP`: across everyone, default 600. It protects the bill if the extension goes viral
    or gets abused.
- Founders get `FOUNDER_HOURLY_CAP` (default 200).
- Invalid requests are rejected before they count against the cap.
- Also set a monthly spending limit on the API key itself in the OpenAI dashboard. The server cannot
  protect against a leaked key.

Limits are in memory, so they reset when the server restarts. Before a public launch, move them to Redis
or similar, and put the server behind HTTPS (set `TRUST_PROXY=1` behind your proxy).

## Models

Only OpenAI's main GPT models can be picked. They are listed in `server/models.json`:

| Model | Price per 1M tokens (in / out) | Role |
|---|---|---|
| `gpt-5.6-luna` | $0.20 / $1.20 | Default for everyone |
| `gpt-5.6-terra` | $2 / $12 | |
| `gpt-5.6-sol` | $4 / $20 | |
| `gpt-6-astra` | $10 / $50 | Founder only; default with a founder token |

- All four read images and are called through Chat Completions with strict JSON-schema output.
- The server ignores any model id that is not in this list.
- To keep an expensive model away from public users, set its `tier` to `"founder"`.

## Tests and preview

```bash
cd server && .venv/bin/python -m unittest test_server      # limits, tiers, validation, reports
PORT=8788 server/.venv/bin/python dev/fake_server.py        # canned problems with every diagram type
python3 -m http.server 8790                                 # then open http://localhost:8790/dev/preview.html
```

The preview page mocks the `chrome.*` APIs and applies the same script policy as an extension page, with no
inline scripts and no `eval`. It talks to the fake server on 8788. Add `?focus=1` to preview focus mode.

## Decisions made where the brief left questions open

| Open question (brief §9) | What this build does |
|---|---|
| Name and brand | PracticeX kit. It is newer than the brief and marked final; the brief called its name and colours temporary. |
| Questions per generation, easier/harder | 1 to 5 per set (slider), with a continuous Easy-to-Hard difficulty slider |
| Enforcing an attempt before reveal | Optional answer box plus a Reveal button. Nothing is forced. |
| Where help videos come from | YouTube and Khan Academy search links |
| Full page or selected region | Region by default; whole page on request |
| Math only? | Math only. The prompt is written for math. |

Not built yet:
- Programmatic answer checking with symbolic or numeric verification. The brief (§7) recommends it over
  a second model. For now the prompt tells the model to check each answer by substitution.
- A privacy policy and EULA.
- Chrome Web Store assets.
