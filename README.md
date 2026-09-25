# Ethyra Intelligence — Canvas Export

A Chrome extension that sends a student's own Canvas coursework to
[Ethyra Intelligence](https://ethyra.com), where it is analysed against the ACT
College and Career Readiness Standards to build a learning profile.

Sign in, click **Export**, done. There is no course picker, no settings, and no
file to save — every active course goes, every time.

> **Status: pre-release.** Never run against a real Canvas account.
> See [Before this is usable](#before-this-is-usable).

---

## A fork, and what that means

This is a fork of
[jasp-nerd/canvas-course-downloader](https://github.com/jasp-nerd/canvas-course-downloader)
(MIT), kept as a real fork so its fixes keep arriving:

```bash
git fetch upstream
git merge upstream/main
```

Upstream mirrors a whole Canvas course to your Downloads folder. This one
collects one student's own work and uploads it. The scope is narrowed by
**configuration**, not by deletion — `ethyra/profile.js` turns eleven content
types down to three — so the code upstream maintains is still here and still
mergeable. `NOTICE` records what changed and what is deliberately left unloaded.

## What it collects

| Collected | Not collected |
|---|---|
| Files you submitted, every attempt | Instructor comments and rubric marks |
| Text you typed into Canvas | Class averages and medians |
| Assignment instructions, verbatim | Course files, pages, modules, quizzes, discussions |
| Rubrics, and files attached to instructions | Anything belonging to another student |
| Due dates and submission dates | |
| Your grade on each gradebook item | |

The exclusions are enforced at the **request**, not by a filter afterwards —
`score_statistics`, `submission_comments` and `rubric_assessment` are never asked
for. Data not requested is data not received, and no later filter can be
forgotten. `ethyra/wiring.test.mjs` fails the build if any of them reappears.

Full detail in [PRIVACY.md](PRIVACY.md).

## How it works

```
popup            sign in, press Export, watch progress
  │                injects the bundle below into the tab, on open
  │
  ├─ background.js ──── holds the Ethyra session and the export's status
  │                     (the popup dies when it loses focus; the export does not)
  │
  └─ content.js ─────── runs inside the Canvas page, because that is where the
       │                session cookie is
       │
       ├─ downloader.js  upstream's collector, in Ethyra mode
       ├─ collect.js     records structured metadata as it goes past
       ├─ archive.js     one streamed zip across every course
       └─ upload.js      POST /api/act/uploads
```

Four decisions worth knowing before changing anything:

**The manifest declares no content scripts.** Upstream matches every HTTPS host,
because self-hosted Canvas is on arbitrary school domains and `detector.js`
decides at runtime. Inherited, that put this bundle in every page the student
visits. Narrowing the pattern to `*.instructure.com` would have fixed it by
dropping self-hosted Canvas, which the backend's `CANVAS_ORIGINS` setting exists
to support — so the declaration is gone and the popup injects into one tab under
`activeTab` instead. The ordered file list now lives in `ethyra/popup.js`, and
`content.js` sets a flag so a second popup open cannot re-inject: these files
declare top-level `const`s, and evaluating them twice is a `SyntaxError`.

**One archive, not one per course.** An upload is a snapshot in a series on the
Ethyra side — six separate uploads would read as six months of progress, start
six analysis runs, and consume six units of a monthly quota whose free tier is
two.

**The manifest is written last.** It has to describe the archive it is inside,
and which files survived cannot be known until they have all been tried — a
Canvas attachment URL carries a time-limited verifier, and one expiring
mid-export is ordinary.

**Manifest paths are read back, never predicted.** Upstream truncates filenames
for Windows path limits and appends ` (2)` on collision, both after collection
has recorded an assignment. Predicting names instead produces a manifest that
disagrees with its own archive.

## Install for development

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this directory
3. Open your Canvas site, click the Ethyra icon

Point it at a local backend by setting the API URL once from the service worker
console (`chrome://extensions` → **service worker**):

```js
chrome.storage.local.set({ ethyra_api_url: "http://localhost:8000" })
```

The backend must allow your Canvas origin. The upload comes from the Canvas page,
not from the extension, so add self-hosted Canvas hosts to `CANVAS_ORIGINS` in
the backend's environment — `*.instructure.com` is already matched by pattern.

## Tests

```bash
node --test "ethyra/*.test.mjs"
```

No dependencies and no browser. Two suites:

- **`manifest.test.mjs`** — the manifest is a contract with a parser, tested like
  one. Includes the pre-flight validator that catches a manifest/archive
  disagreement before the upload rather than as a 400 afterwards.
- **`wiring.test.mjs`** — content scripts share one scope and load in manifest
  order, so a missing or misordered file is a `ReferenceError` in a page console
  nobody is watching, halfway through an export. This checks every cross-file
  symbol by name, and pins two live hazards: `ui.js` and `turndown.min.js` are no
  longer loaded, and nothing reachable may call into them.

## Before this is usable

- [ ] **Verify against a real Canvas instance.** Whether `description`, `rubric`
      and `submission_history` come back to a *student* varies with instance
      policy and muted assignments. Everything degrades gracefully if they do
      not, but the value proposition changes.
- [ ] **Branding.** `icons/` is still upstream's artwork.
- [ ] **Fill the `[TODO]` placeholders in PRIVACY.md** — retention, the legal
      entity, the FERPA posture, the Azure model-training position, and the
      contact address. A privacy policy is a Chrome Web Store gate and must not
      ship with placeholders in it. `wiring.test.mjs` fails the build if any
      remain once `manifest.json` leaves `0.x`, so this cannot be forgotten at
      submission time — but the facts are legal and business decisions and must
      not be invented to clear the test.
- [ ] **Two backend facts the policy depends on**, both verified against
      `ethyra-intelligence-backend` on 2026-09-17 and neither fixable here:
      there is **no retention or expiry mechanism of any kind** — no scheduled
      purge, no blob lifecycle policy, nothing removed except by the delete
      endpoint — and **deleting an upload does not remove the extracted text**,
      which is stored keyed on content hash, shared across users by design, and
      carries no user id. Both change what the policy has to say, and one may be
      a bug rather than a disclosure.
- [ ] **Backend must be deployed** with the `CANVAS_ORIGINS` and `X-Client`
      changes from the `chrome-extension` branch, or sign-in succeeds and the
      first token refresh fails.

## Known limitations

**The Canvas tab is the process.** A content script dies when its page
navigates, so browsing away mid-export cancels it. The popup warns while one is
running. This is inherent to doing the work in the page, which is itself
inherent to where the Canvas session cookie lives.

**No cancel button yet.** Cancelling means reaching into a content script that
may have outlived several popups, and a half-cancelled export that still uploads
would be worse than no cancel at all.

**500 MB ceiling**, matching the backend. Files over 50 MB are skipped
individually with a warning; an export over the total refuses rather than
silently trimming, because dropping work to fit under a limit produces a
learning graph missing assignments nobody was told about.

## Licence

MIT. `LICENSE` is upstream's, retained as that licence requires. See `NOTICE`.
