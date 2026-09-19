/**
 * The service worker: the Ethyra session, and the state of the current export.
 *
 * Original to this fork. Upstream's `background.js` is still in the tree and is
 * deliberately not loaded — it is a `chrome.downloads` queue, and registering
 * its `chrome.downloads.onChanged` listener would force this extension to
 * request a `downloads` permission it never uses and could not justify at
 * review. Leaving the file in place keeps `git merge upstream/main` clean; a
 * merge that touches a file nothing loads is harmless.
 *
 * ── Why the worker holds the export state at all ──────────────────────
 *
 * The export runs in the content script, which lives as long as the Canvas tab
 * does. The popup does not: it is destroyed the moment it loses focus, which
 * for a twenty-minute export is most of the time.
 *
 * So progress is reported here and the popup reads it on open. Without that, a
 * student who clicked Export and then clicked anywhere else would reopen the
 * popup to a blank sign-in screen with no way to tell whether their export was
 * still running.
 *
 * ── Why the access token is passed to the page, not kept here ─────────
 *
 * The upload has to happen in the content script — a 300 MB Blob cannot cross
 * `chrome.runtime.sendMessage`, and the two contexts do not share storage — so
 * the token has to travel. It is handed over only in response to a START_EXPORT
 * the student initiated, never stored where a page can read it, and it expires.
 */

importScripts("./auth.js");

/** Default API, overridable per install so a dev build can point at localhost. */
const DEFAULT_API_URL = "https://api.ethyra.com";

/**
 * Where "View in Ethyra" goes.
 *
 * NOTE: this default is a guess and must be confirmed before release. Nothing in
 * `ethyra-intelligence-backend` pins a production web-app URL — `FRONTEND_URL`
 * defaults to empty and is `http://localhost:3001` in development, and
 * `WEBSITE_URL` is the marketing site rather than the app. So this is inferred
 * from `api.ethyra.com` and nothing else.
 *
 * Overridable the same way the API is, which is also how you point it at a local
 * frontend:
 *
 *   chrome.storage.local.set({ ethyra_web_url: "http://localhost:3001" })
 */
const DEFAULT_WEB_URL = "https://app.ethyra.com";

/**
 * The export in flight, if any.
 *
 * `chrome.storage.session` rather than a module variable: MV3 kills an idle
 * worker within seconds, and a module variable would take the progress a
 * student is watching with it.
 */
const EXPORT_STATE_KEY = "ethyra_export_state";

async function readExportState() {
  const stored = await chrome.storage.session.get(EXPORT_STATE_KEY);
  return stored[EXPORT_STATE_KEY] || { status: "idle" };
}

async function writeExportState(state) {
  await chrome.storage.session.set({ [EXPORT_STATE_KEY]: state });
}

/**
 * Serialise every read-modify-write of the export state.
 *
 * ── The race this exists to stop ──────────────────────────────────────
 *
 * A successful upload fires two messages back to back: `uploadArchive` reports
 * `{phase: "uploaded"}` from its `onload`, then resolves, and `runExport`
 * immediately sends `ETHYRA_EXPORT_DONE`. Both land in the listener below, both
 * are async, and the progress branch is a check-then-act:
 *
 *   PROGRESS  reads  {status: "running"}
 *   DONE      writes {status: "done"}            ← the export is finished
 *   PROGRESS  writes {...read, status: "running"} ← and now it is not
 *
 * The `state.status !== "running"` guard does not help: it read the old value
 * before DONE wrote the new one. The window is microseconds wide and sits at the
 * exact point where the two messages are guaranteed to be adjacent, which is why
 * it fires on a fast local backend rather than never.
 *
 * The result is a popup pinned on "Uploaded — Ethyra is reading it now" with no
 * way out, for an export that actually succeeded.
 *
 * Chaining the mutations through one promise makes the read and the write of a
 * single handler atomic with respect to the others. The service worker is
 * single-threaded, so nothing stronger is needed — the bug is interleaved
 * `await`s, not parallel ones.
 */
/**
 * A run that has stopped moving, by the backend's own vocabulary.
 *
 * `job_runner` writes `running` while it works and settles on one of these.
 * `partial` is a success with casualties — some assignments failed and the rest
 * committed — so it belongs here rather than with `failed`: the student has
 * results to look at either way.
 */
const RUN_TERMINAL = new Set(["ready", "partial", "failed"]);

/**
 * Where the analysis stands, for an upload this extension sent.
 *
 * ── Why the worker asks, and not the content script ───────────────────
 *
 * Analysis outlives the export by minutes. The content script does not: it dies
 * with its tab, and a student who uploads and then navigates back to their
 * coursework — the obvious thing to do while waiting — would take the only
 * thing watching down with them.
 *
 * The worker has `https://api.ethyra.com/*` in `host_permissions`, so this fetch
 * is exempt from CORS and needs no allowance on the backend's side.
 *
 * Polled only while the popup is open. The analysis itself is entirely
 * server-side and does not care whether anyone is watching — so there is no
 * `chrome.alarms` here, and closing the popup costs nothing but the view.
 */
async function fetchRun(apiUrl, uploadId) {
  if (!uploadId) return null;
  const accessToken = await getAccessToken();
  if (!accessToken) return null;

  const res = await fetch(`${apiUrl}/api/act/runs`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Client": "extension" },
  });
  if (!res.ok) return null;

  const runs = await res.json();
  // Matched on `upload_id` rather than taking the newest. A student with two
  // devices, or one who uploaded by hand from the web app while this was
  // running, would otherwise watch somebody else's progress bar — their own.
  return (runs || []).find((r) => String(r.upload_id) === String(uploadId)) || null;
}

let exportStateQueue = Promise.resolve();

function withExportState(mutate) {
  const run = exportStateQueue.then(mutate, mutate);
  // Swallow on the QUEUE only: a rejection must not poison every later
  // mutation, but the caller still sees its own failure through `run`.
  exportStateQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function getApiUrl() {
  const stored = await chrome.storage.local.get("ethyra_api_url");
  return stored.ethyra_api_url || DEFAULT_API_URL;
}

async function getWebUrl() {
  const stored = await chrome.storage.local.get("ethyra_web_url");
  return stored.ethyra_web_url || DEFAULT_WEB_URL;
}

/**
 * Confirm access to Canvas's CDN, where submitted files actually live.
 *
 * A CHECK, never a request — and that distinction was a real bug.
 *
 * Upstream declares this origin optional and asks for it at runtime. In MV3
 * `chrome.permissions.request()` only works inside an active user gesture; a
 * gesture survives exactly one synchronous message hop from a UI context, and
 * dies at the first `await`. This handler failed all three ways at once: the
 * message arrives from a CONTENT SCRIPT several async hops into an export, the
 * listener body is already async before reaching the switch, and the old
 * implementation awaited `contains()` before requesting. It could not succeed —
 * not "might be denied", could not succeed.
 *
 * What made it invisible is what the caller did next: warn, continue, fail the
 * CDN fetches individually, and let `pruneFailed` rewrite the manifest to match
 * whatever downloaded. The archive stayed internally consistent, so the backend
 * had no way to tell a student whose files were unreachable from one who had
 * submitted less.
 *
 * So the origin moved to `host_permissions`, granted at install. The one
 * remaining question is whether it is actually present, and a `false` here means
 * a broken install rather than a preference — the caller aborts.
 */
async function ensureCdnPermission() {
  const granted = await chrome.permissions.contains({
    origins: ["https://*.canvas-user-content.com/*"],
  });
  if (!granted) {
    console.error("[Ethyra] The canvas-user-content.com host permission is missing from this install.");
  }
  return { granted };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Every branch is async, so the listener returns true and replies later.
  (async () => {
    try {
      switch (message?.type) {
        case "ENSURE_CDN_PERMISSION":
          sendResponse(await ensureCdnPermission());
          return;

        case "ETHYRA_GET_SESSION": {
          const apiUrl = await getApiUrl();
          sendResponse({
            apiUrl,
            webUrl: await getWebUrl(),
            user: await currentUser(),
            export: await readExportState(),
          });
          return;
        }

        /**
         * Open the web app.
         *
         * Opened from the worker rather than with a plain `<a target="_blank">`
         * in the popup, because the URL is configurable and the popup has no
         * business reading storage the worker already owns.
         */
        case "ETHYRA_OPEN_WEB_APP":
          await chrome.tabs.create({ url: await getWebUrl() });
          sendResponse({ ok: true });
          return;

        case "ETHYRA_SET_API_URL":
          await chrome.storage.local.set({ ethyra_api_url: message.apiUrl });
          sendResponse({ ok: true });
          return;

        case "ETHYRA_SIGN_IN": {
          const apiUrl = await getApiUrl();
          const user = await signIn(apiUrl, message.email, message.password);
          sendResponse({ ok: true, user });
          return;
        }

        case "ETHYRA_SIGN_UP": {
          const apiUrl = await getApiUrl();
          const user = await signUp(apiUrl, {
            email: message.email,
            password: message.password,
            acceptTerms: message.acceptTerms,
            firstName: message.firstName,
            lastName: message.lastName,
          });
          sendResponse({ ok: true, user });
          return;
        }

        case "ETHYRA_SIGN_OUT":
          await signOut(await getApiUrl());
          await writeExportState({ status: "idle" });
          sendResponse({ ok: true });
          return;

        /**
         * Hand the content script what it needs to run an export.
         *
         * The token is minted here, at the moment the student asks, rather than
         * being held in the page for the duration.
         */
        case "ETHYRA_BEGIN_EXPORT": {
          const apiUrl = await getApiUrl();
          const accessToken = await getAccessToken();
          if (!accessToken) {
            sendResponse({ ok: false, error: "Your Ethyra session has expired. Sign in again." });
            return;
          }

          /**
           * One export at a time, enforced here rather than by the popup.
           *
           * ── Why the popup hiding the button was not enough ──────────
           *
           * `boot()` only offers Export when the state is idle, which is a
           * guard on the VIEW. It holds for one popup looking at a fresh
           * state, and not otherwise:
           *
           *   - Two Canvas tabs, two popups. `content.js` guards
           *     `exportInFlight` per tab, so its check passes in the second
           *     tab while the first is mid-export.
           *   - A popup opened before an export began, left open, and clicked
           *     after — it is rendering a state that has since moved.
           *
           * The cost of losing that race is not a wasted click. Two exports
           * from one account race to upload archives of the same coursework;
           * the backend takes both, sequences them 1 and 2, and reads the
           * second as a later snapshot in a series — so `trend` sees progress
           * between two uploads taken minutes apart, and the quota is charged
           * twice for one answer.
           *
           * The read and the write are in one queued step because this is the
           * same check-then-act that let a finished export be overwritten; see
           * `withExportState`.
           */
          const refusal = await withExportState(async () => {
            const state = await readExportState();
            if (state.status === "running") {
              return "An export is already running. Open the Ethyra icon on that tab to watch it.";
            }
            if (state.status === "analyzing") {
              return "Ethyra is still reading your last upload. Wait for it to finish before sending more.";
            }
            await writeExportState({ status: "running", phase: "starting", startedAt: Date.now() });
            return null;
          });

          if (refusal) {
            sendResponse({ ok: false, error: refusal });
            return;
          }
          sendResponse({ ok: true, apiUrl, accessToken });
          return;
        }

        /** Progress from the content script, for whenever the popup reopens. */
        case "ETHYRA_EXPORT_PROGRESS": {
          // Read and write inside one queued step, or a DONE landing between
          // them is overwritten and the export never finishes. See
          // `withExportState`.
          await withExportState(async () => {
            const state = await readExportState();
            if (state.status !== "running") return;
            await writeExportState({ ...state, ...message.progress, status: "running" });
          });
          sendResponse({ ok: true });
          return;
        }

        case "ETHYRA_EXPORT_DONE":
          await withExportState(() =>
            writeExportState({
              // A successful upload is not the end of anything the student
              // cares about — the agents have not read a word yet. Calling it
              // "done" here is what made the popup announce success and then
              // sit on a sentence about Ethyra reading the files with no way to
              // see whether it was.
              status: message.error ? "failed" : message.uploadId ? "analyzing" : "done",
              error: message.error || null,
              warnings: message.warnings || [],
              uploadId: message.uploadId || null,
              uploadedAt: Date.now(),
            })
          );
          sendResponse({ ok: true });
          return;

        /** Where the analysis stands. Asked by the popup, only while it is open. */
        case "ETHYRA_GET_RUN": {
          const apiUrl = await getApiUrl();
          const state = await readExportState();
          try {
            sendResponse({ ok: true, run: await fetchRun(apiUrl, state.uploadId) });
          } catch (err) {
            // A failed poll is not a failed analysis, and must not be reported
            // as one — the run is server-side and unaffected by whether this
            // request reached it.
            console.warn("[Ethyra] Run poll failed:", err);
            sendResponse({ ok: true, run: null, pollError: true });
          }
          return;
        }

        /** The analysis has settled, or the student stopped watching it. */
        case "ETHYRA_FINISH_ANALYSIS":
          await withExportState(async () => {
            const state = await readExportState();
            if (state.status !== "analyzing") return;
            await writeExportState({
              ...state,
              status: "done",
              run: message.run || null,
              finishedAt: Date.now(),
            });
          });
          sendResponse({ ok: true });
          return;

        case "ETHYRA_CLEAR_EXPORT":
          await withExportState(() => writeExportState({ status: "idle" }));
          sendResponse({ ok: true });
          return;

        default:
          sendResponse({ ok: false, error: `Unknown message ${message?.type}` });
      }
    } catch (err) {
      console.error("[Ethyra] Background error:", err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});
