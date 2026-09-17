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

async function getApiUrl() {
  const stored = await chrome.storage.local.get("ethyra_api_url");
  return stored.ethyra_api_url || DEFAULT_API_URL;
}

/**
 * Ask for access to Canvas's CDN, where submitted files actually live.
 *
 * Kept from upstream's worker because `downloader.js` still sends this message
 * and the reason is unchanged: `optional_host_permissions` can only be
 * requested from a user gesture, and the content script has no way to do it.
 * Denial is non-fatal — those files fail individually and are reported.
 */
async function ensureCdnPermission() {
  const permission = { origins: ["https://*.canvas-user-content.com/*"] };
  if (await chrome.permissions.contains(permission)) return { granted: true };
  try {
    return { granted: await chrome.permissions.request(permission) };
  } catch {
    return { granted: false };
  }
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
            user: await currentUser(),
            export: await readExportState(),
          });
          return;
        }

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
          await writeExportState({ status: "running", phase: "starting", startedAt: Date.now() });
          sendResponse({ ok: true, apiUrl, accessToken });
          return;
        }

        /** Progress from the content script, for whenever the popup reopens. */
        case "ETHYRA_EXPORT_PROGRESS": {
          const state = await readExportState();
          if (state.status !== "running") {
            sendResponse({ ok: true });
            return;
          }
          await writeExportState({ ...state, ...message.progress, status: "running" });
          sendResponse({ ok: true });
          return;
        }

        case "ETHYRA_EXPORT_DONE":
          await writeExportState({
            status: message.error ? "failed" : "done",
            error: message.error || null,
            warnings: message.warnings || [],
            uploadId: message.uploadId || null,
            finishedAt: Date.now(),
          });
          sendResponse({ ok: true });
          return;

        case "ETHYRA_CLEAR_EXPORT":
          await writeExportState({ status: "idle" });
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
