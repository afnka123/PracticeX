# PracticeX — Chrome Web Store listing

Everything below is copy-paste ready. Field names match the Developer Dashboard tabs.
Replace `afnka123.github.io/PracticeX` if you host the policy somewhere else.

---

## Tab: Store listing

**Extension name** (from manifest, cannot edit here)
PracticeX

**Summary** (132 chars max — shows in search results)
Screenshot any question and get new practice problems just like it, with answers and worked solutions.

**Description**
PracticeX reads the question on your screen and writes new practice problems of the same type. It does not solve your homework. It makes more of it.

HOW IT WORKS
1. Open any page with a problem on it — a worksheet, a textbook PDF, a homework site.
2. Click the PracticeX icon and drag a box over the question.
3. Get 1 to 5 new problems that practice the same skill, at the difficulty you choose.

Each problem comes with an answer and a full worked solution: the approach, the steps, a check, and the common mistake to watch for. The answer stays hidden until you ask for it, so you actually practice.

WHAT IT COVERS
Math, physics, chemistry, biology, writing (grammar, essays, reading comprehension), foreign languages, and history. Formulas render properly. Where a diagram helps — geometry, vectors, graphs, 3D shapes — PracticeX draws one you can zoom, rotate, and click on.

FEATURES
• Difficulty slider — from easier than the original to a real stretch
• Written or multiple-choice answers
• Check answer — type your answer and find out if it's right, with a hint if it's not
• Struggling? — the prerequisite skills you're missing, with links to videos
• More like these — another set on the same skill, easier or harder
• Your progress — problems solved, accuracy, day streak, strongest and weakest subjects
• Classes — file your practice by the course you're taking
• Text size and detail level settings

PRIVACY
Only the region you select is sent, and only when you click Generate. Screenshots are never stored. Your history and progress stay on your computer. No account, no sign-up, no tracking. Full policy: https://afnka123.github.io/PracticeX/privacy.html

FREE WITH AN HOURLY LIMIT
PracticeX is free. To keep it that way, each install gets a set number of generations per hour. The panel always shows how many you have left.

**Category**
Education

**Language**
English (United States)

**Official URL** (optional)
https://afnka123.github.io/PracticeX/

**Homepage URL** (optional)
https://github.com/afnka123/PracticeX

**Support URL** (optional)
https://github.com/afnka123/PracticeX/issues

**Graphic assets** (in this folder)
- Store icon 128×128: `extension/icons/icon128.png` (auto-pulled from the ZIP)
- Screenshots 1280×800: `store/screenshot-1.png` … (at least one required, up to five)
- Small promo tile 440×280: `store/promo-small.png`
- Marquee promo tile 1400×560 (optional): `store/promo-marquee.png`

---

## Tab: Privacy practices

**Single purpose description**
PracticeX generates new practice problems that resemble a question the user selects on screen, with answers and worked solutions, so students can practice a skill.

**Permission justifications**

`storage`
Saves the student's practice history, class list and settings (difficulty, text size, answer format) locally in chrome.storage.local so progress persists between sessions. Nothing in storage is sent to a server.

`optional_host_permissions: <all_urls>` (host permission)
Required by chrome.tabs.captureVisibleTab to screenshot the tab the student is looking at, which is the only way PracticeX can read the question. It is an optional permission requested on the first click of Generate, not at install. PracticeX does not inject content scripts, read or modify page DOM, or run on any page in the background. The student then crops the screenshot to the question, and only the cropped region leaves the browser.

**Are you using remote code?**
No. All JavaScript, including MathJax, is bundled in the extension package. The extension makes fetch requests to its own API for data only.

**Data usage — check these boxes:**

Which of the following does your item collect?
- [ ] Personally identifiable information
- [ ] Health information
- [ ] Financial and payment information
- [ ] Authentication information
- [ ] Personal communications
- [ ] Location
- [x] Web history — NO, leave unchecked (see note)
- [x] User activity — CHECK THIS: typed answers are sent for checking; problems the user reports are stored
- [x] Website content — CHECK THIS: the screenshot region the user selects is sent to generate problems

  Note: Do NOT check "Web history". PracticeX does not record URLs or pages visited. The screenshot is an image of user-selected content, which falls under "Website content".

Certify all three:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**
https://afnka123.github.io/PracticeX/privacy.html

---

## Tab: Distribution

**Visibility**
- Pilot / testing with a class: **Unlisted** (anyone with the link can install; not in search)
- Launch: **Public**

**Regions**
All regions

**Pricing**
Free

---

## After approval

1. Copy the extension ID from the dashboard (or `chrome://extensions`).
2. Render → practicex-server → Environment → add `ALLOWED_EXTENSION_IDS` = that ID → Save.
3. Replace the `#` in `docs/index.html` "Add to Chrome" with the store URL:
   `https://chromewebstore.google.com/detail/<extension-id>`
4. Paste your FOUNDER_TOKEN into the extension's Settings (gear) for the higher cap.
   Note: on the store build the Developer fields are hidden, so use an unpacked copy for founder mode.

## Updating later

Bump `"version"` in `extension/manifest.json` (e.g. 0.5.1), rebuild the ZIP, upload it under
Package → Upload new package, and submit. Every upload needs a higher version than the last.
