# A local Canvas to test against

Free-for-Teacher closed to new signups in September 2026 and its replacement,
Canvas Lite (`canvaslite.instructure.com`, live 2026-09-30), publishes no
statement about whether `/api/v1` answers a session-authenticated same-origin
request. It removes *API access tokens*, which is a different mechanism than the
one this extension uses — but "probably fine" is not a test environment.

So: a real Canvas, locally, where you are the admin and nothing is gated.

This is a real Canvas codebase, not a stand-in. That is the entire point — a
hand-written mock of `/api/v1` would encode our beliefs about
`submission_history`, and then agree with them.

## Prerequisites

A container runtime — Docker Desktop, OrbStack or colima. Budget ~10 GB of
disk: a 3 GB image, Postgres, and the named volumes.

Memory is less of a problem than the Canvas development environment's
reputation suggests. Assets ship prebuilt in the image's `public_dist` volume,
so there is no first-boot webpack compile to survive. Measured at rest, the
whole stack — two Rails processes, Postgres, Redis — sits around **1.2 GB**. A
default 8 GB VM is ample.

## First run

The image carries its own database-init scripts, and compose cannot extract
them from an image it has not started. So they come out by hand, once:

```bash
cd dev
docker create --name tmpCanvas lthub/canvas-dev-only:release.2026-01-28.626.arm
mkdir -p docker/dev/canvas
docker cp tmpCanvas:/usr/src/app/dbinit/. docker/dev/canvas/
docker rm -f tmpCanvas

docker compose up
```

The 3 GB pull dominates. After that, Canvas answers on
<http://localhost:9100> within about five seconds — Postgres restores from the
dump quickly and there is no asset compile. If it has not answered in a minute,
something is wrong; `docker compose logs -f canvas` will say what.

Admin is **`admin@example.com` / `password`**. The Docker Hub page for this
image says `admin@instructure.com`; that is wrong, and the `pseudonyms` table in
`02_canvas_development.sql` is the authority.

The database ships pre-migrated, so there is no `rake db:initial_setup` to run —
but it ships with **no content**: one user, no courses, no enrolments, no
assignments, no submissions. Every fixture is yours to create. That is what
`seed.mjs` is for.

## Why this is a `.arm` tag

`release.2026-01-28.626.arm` is a native arm64 build. The plain
`release.2026-01-28.626` is amd64 and runs under emulation on Apple Silicon,
which for a Rails app recompiling assets on demand is the difference between
slow and unusable.

## The one backend change this needs

The upload is sent from the Canvas page, not from the extension, so its `Origin`
is the Canvas host. `ethyra-intelligence-backend` admits Canvas origins by the
pattern `^https://[a-z0-9-]+\.instructure\.com$` — which a local instance does
not match, on two counts. Add it explicitly:

```bash
# ethyra-intelligence-backend/.env
CANVAS_ORIGINS=http://localhost:9100
```

`CANVAS_ORIGINS` is an exact-match set rather than a pattern, so the `http` and
the port are both fine there. Without it the upload dies in preflight, and the
extension reports a failure that has nothing to do with the export.

It goes in `.env` rather than on the command line because the backend's dev
launcher is `python main.py` — which also starts Azurite, and without a blob
backend an upload 503s rather than failing visibly at the CORS layer. Running
`uvicorn app.main:app` by hand skips that and produces a backend that looks
healthy until the moment a file is stored.

`main.py` listens on **8001**. Point the extension at it once, from the service
worker console (`chrome://extensions` → **service worker**):

```js
chrome.storage.local.set({ ethyra_api_url: "http://localhost:8001" })
```

### `http://localhost:8001/*` is in `host_permissions`, and must not ship

A service-worker fetch to a host in `host_permissions` is exempt from CORS.
Without that entry, sign-in from the worker carries
`Origin: chrome-extension://…`, which the backend does not admit on
`/api/auth/*` — correctly, since that is the same door it keeps shut against
Canvas origins. Production is unaffected: `https://api.ethyra.com/*` is already
listed, so the exemption applies there too.

A published extension holding a localhost permission can reach whatever happens
to be listening on that port on someone else's machine. `wiring.test.mjs` fails
the build if the entry survives past `0.x`, on the same reasoning as the privacy
placeholders — the version bump is the one thing a store submission cannot skip.

## What needs no change

- **Host permissions.** The extension declares no `content_scripts` and injects
  on demand under `activeTab` (see the comment above `CONTENT_SCRIPTS` in
  `ethyra/popup.js`), which grants access to whatever host is in the active tab
  when the toolbar icon is clicked. `localhost:9100` is covered.
- **Canvas detection.** `detector.js` falls back to DOM signals — `.ic-app`, a
  `brandable_css` link — which a real Canvas serves on any domain. The
  `instructure.com` hostname check on line 54 is a fast path, not a gate.
- **The `canvas-user-content.com` CORS rule** in `rules.json`. A local instance
  serves attachments from its own origin, so that rule simply does not apply.
  This is a divergence from production worth remembering: the expiring-verifier
  failure mode is one thing local Canvas will *not* reproduce.

## Fixtures

```bash
node dev/seed.mjs
```

Builds everything in the table below and prints the logins. Runs as the site
admin, using `as_user_id` masquerade for the acts that must belong to the
student — a submission recorded against the admin is not evidence about the
student and the exporter would skip it anyway.

**Idempotent for users, courses and assignments; not for submissions.** Canvas
has no upsert, so the script looks up by name before creating — but a submission
is an append by definition, and re-running adds another attempt. Expect
`Proof Set 1` to climb past two attempts if you run it repeatedly. To start
clean: `docker compose down -v` and boot again.

Run the export **signed in as the student**. A course you teach is refused
before anything is fetched from it (`ETHYRA_NOT_A_STUDENT` in
`ethyra/profile.js`), so running as the teacher produces an empty export by
design — that is the `Peer Tutoring Seminar` fixture.

Two courses, not one. A `courses[]` of length one does not exercise the
one-zip-every-course model that the whole manifest design rests on.

### `submission_history` collapses at one-second resolution

Canvas de-duplicates `submission_history` by `submitted_at` to the second. Two
versions sharing a second are returned as a single entry even though both rows
exist in the `versions` table.

A student resubmitting days later never meets this. A seeder firing two
submissions in one tick meets it every time, and the result is a convincing
false negative: `attempt` reads 2, the history reads 1, and it looks exactly
like the exporter dropped an attempt. `seed.mjs` sleeps between attempts for
this reason and no other — do not remove it to make the script faster.

This is the first thing a hand-written mock of `/api/v1` would have got wrong,
in our favour, silently.

| Fixture | What it exercises |
|---|---|
| File-upload assignment, submitted | the ordinary path, `ROLE_SUBMISSION` |
| Text-entry assignment with an embedded image | the rich-text case the unclaimed-file warning was added for |
| One assignment submitted twice | `submission_history`, the `attempt` field |
| Rubric + a file attached to the description | `linkedFiles`, teacher-attachment role |
| Assignment with instructions, never submitted | the skip in `collect.js` — must not reach the manifest |
| Two assignments sharing their first 80 characters | the truncation collision `collect.js` documents at length |
| A teacher comment on a submission | the comment thread capture |
| A course where the test user is the teacher | the `ETHYRA_NOT_A_STUDENT` skip, and its warning |

Grade and **post** at least one submission — Canvas's manual posting policy
hides scores until posted, and whether `score` and `grade` reach a student is
the open question in the root README.

## Open question this is here to answer

From the root README: whether `description`, `rubric` and `submission_history`
come back to a *student* varies with instance policy. Everything degrades
gracefully if they do not, but the value proposition changes. A local instance
lets you toggle those policies and watch what the export does — which is the one
thing neither a mock nor a borrowed account can give you.
