/**
 * The export, run inside the Canvas page.
 *
 * Original to this fork. Upstream's `content.js` is still in the tree and is not
 * loaded — it injects the in-page download button and panel, which this fork
 * replaced with the popup.
 *
 * ── Injected by the popup, not by the manifest ────────────────────────
 *
 * There is no `content_scripts` declaration; `ethyra/popup.js` injects this
 * bundle into the active tab when the student opens the popup, and explains why
 * there. The flag below is what stops it being injected twice: these files
 * declare top-level `const`s, and a second evaluation in the same isolated world
 * is a `SyntaxError` that would kill the listener the first one registered.
 *
 * It is set before the Canvas check, not inside it. A non-Canvas tab loads this
 * bundle too — it just does nothing — and re-injecting there would throw the
 * same way.
 *
 * ── Why the export can run in the page ────────────────────────────────
 *
 * A content script's `fetch` to `/api/v1/...` is same-origin, so the Canvas
 * session cookie goes with it on any Canvas, self-hosted ones included. The
 * offscreen page gets the same cookie only for hosts in `host_permissions`.
 *
 * The upload happens here too, rather than being handed back to the worker: a
 * 300 MB Blob does not survive `chrome.runtime.sendMessage`. The cost is that
 * the upload's `Origin` is the Canvas host, which the backend's allowlist has to
 * admit — see `upload.js`.
 *
 * ── The tab is the process — so this is now the fallback ─────────────
 *
 * A content script dies when its page navigates or closes. That is why an
 * export normally runs in `ethyra/offscreen.html` instead, which has no tab to
 * lose, and only runs here when the offscreen page cannot reach this Canvas (a
 * self-hosted domain outside `host_permissions`, or a session cookie Chrome
 * would not send). Here, `beforeunload` warns before navigating away mid-export.
 *
 * The export itself is `runExport` in `run-export.js`, shared by both.
 */

window.__ethyraContentScriptLoaded = true;

if (isCanvas()) {
  let exportInFlight = null;

  window.addEventListener("beforeunload", (event) => {
    if (!exportInFlight) return;
    // Chrome shows its own wording; what matters is that the prompt appears.
    event.preventDefault();
    event.returnValue = "";
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // A cheap liveness check: the popup uses it to tell "this tab is Canvas and
    // the content script is loaded" from "reload the page first".
    if (message?.type === "ETHYRA_PING") {
      // `exporting` lets the worker tell a running export from one this tab
      // lost — see `checkStillRunning` in background.js.
      sendResponse({ ok: true, host: window.location.host, exporting: Boolean(exportInFlight) });
      return false;
    }

    if (message?.type === "ETHYRA_RUN_EXPORT") {
      if (exportInFlight) {
        sendResponse({ ok: false, error: "An export is already running in this tab." });
        return false;
      }
      exportInFlight = runExport({ ...message, origin: window.location.origin }).finally(() => {
        exportInFlight = null;
      });
      // Answered immediately: the export outlives the popup, and progress
      // arrives through the worker rather than through this reply.
      sendResponse({ ok: true, started: true });
      return false;
    }

    return false;
  });
}
