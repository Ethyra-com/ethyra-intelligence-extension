# Ethyra Canvas Export

A Chrome extension that sends a student's own Canvas coursework to
[Ethyra](https://ethyra.com), where it is analysed against the ACT
College and Career Readiness Standards to build a learning profile.

Sign in, click **Export**, done. There is no course picker, no settings, and no
file to save — every course, current and past, goes every time.

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
| Your grade on each gradebook item, in courses you submitted work to | |

The exclusions are enforced at the **request**, not by a filter afterwards —
`score_statistics`, `submission_comments` and `rubric_assessment` are never asked
for. Data not requested is data not received, and no later filter can be
forgotten. `ethyra/wiring.test.mjs` fails the build if any of them reappears.

Full detail in [LEGAL.md](LEGAL.md): Ethyra's privacy policy and terms, one document for the web app and this extension. It is a copy of `ethyra-intelligence-backend/LEGAL.md`; edit that one and copy it here.

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
       ├─ collect.js     records structured metadata; sends each course as it goes
       ├─ upload.js      per course: hash → /files → PUT new files; then /complete
       └─ archive.js     one zip in one request, only for a backend without /files
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

**One upload, not one per course.** Files go up course by course, but the
export ends in a single `/complete` with one manifest for every course. An
upload is a snapshot in a series on the Ethyra side — six separate uploads would
read as six months of progress, start six analysis runs, and consume six units
of a monthly quota whose free tier is two.

**The manifest is sent last.** It has to name only files that arrived, and which
ones did cannot be known until they have all been tried — a Canvas attachment
URL carries a time-limited verifier, and one expiring mid-export is ordinary. A
file that could not be fetched is dropped from its course's entry before
`/complete`.

**Each file goes straight to blob storage, once.** A student with every past
course has 1-2 GB of work, most of it sent last time. As each course is
collected, its files are fetched a few at a time, hashed (SHA-256), and
`POST /api/act/uploads/files` answers with a create-only URL for each file this
student has never sent; only those are PUT. `POST /api/act/uploads/complete`
then sends the manifest, every file named by its hash. Files live in the
student's own store (`{user}/files/{sha256}`), so a re-export sends almost
nothing. A backend without `/files` is detected by the first `/files` request,
before anything is sent, and gets one zip in one request instead, capped at
500 MB. Only that first request decides it: a later failure is retried, then
reported.

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

## Package for the Chrome Web Store

```bash
node scripts/package.mjs
```

Writes `dist/ethyra-canvas-export-<version>.zip`. Upload that, never a zip of this
directory. The script:

- removes the dev hosts (`localhost`, the Azure dev backend) from the manifest's
  `host_permissions`, and fails if any host other than Canvas and
  `api.ethyra.com` is left;
- leaves out everything that doesn't run: `dev/`, `tests/`, `screenshots/`,
  `.github/`, `_metadata/`, tests, markdown docs, and the upstream files nothing
  loads (see [NOTICE](NOTICE));
- keeps `LICENSE` and `NOTICE`, which the MIT licence requires.

Bump `version` in `manifest.json` before every upload; the store refuses a
version that isn't higher than the last one.

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
- [ ] **Publish [LEGAL.md](LEGAL.md) on the website.** Its privacy page URL is
      what the Chrome Web Store listing points to. See
      [CHROME_WEB_STORE.md](CHROME_WEB_STORE.md) for the rest of submission.
- [ ] **Storage account set up for direct upload** (`ethyraintelligence`):
      a CORS rule letting any origin `PUT`/`OPTIONS` with headers
      `x-ms-blob-type` and `content-type` (schools run Canvas on their own
      domains, and the signed URL is what authorises the write), and
      **Storage Blob Delegator** at account scope for the backend's managed
      identity, which signs the URL with a user delegation key. Its existing
      Blob Data Contributor is scoped to one container, which cannot request
      that key. Without the role, `/files` answers 501 and the export falls back
      to one zip (500 MB cap); without CORS, the PUTs fail.
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

**Size limits.** Files over 50 MB are skipped individually with a warning. Past
that, the export never trims work to fit — dropping assignments to get under a
limit produces a learning graph missing work nobody was told about — so over a
limit it stops and says so:

- **Per-file upload: 10 GB** across the export (`ETHYRA_MAX_TOTAL_BYTES`,
  matching the backend's `MAX_DIRECT_UPLOAD_BYTES`). Checked before each batch
  is sent, so an export over it stops partway with at most 10 GB stored. Files
  already sent stay in the student's store and are skipped by the next export;
  they are kept until the student deletes them (see LEGAL.md).
- **One-zip fallback: 500 MB** (`ETHYRA_MAX_ZIP_BYTES`, matching the backend's
  `MAX_UPLOAD_BYTES`). Checked on Canvas's sizes before anything is fetched and
  again on the real bytes while the zip is built. Nothing is uploaded when it is
  over.

## Licence

MIT. `LICENSE` is upstream's, retained as that licence requires. See `NOTICE`.
