/**
 * The export, run in a page of its own so closing Canvas does not stop it.
 *
 * Original to this fork. The service worker creates this page (a Chrome
 * offscreen document) when the student clicks Export and closes it when the
 * export reports done. It has no tab and no window, so nothing the student does
 * in Canvas can end it. Only quitting Chrome does, and the next export skips
 * every file already sent.
 *
 * ── How it reads Canvas without being Canvas ──────────────────────────
 *
 * The content script reads Canvas from inside the page, where the session
 * cookie goes with every request. This page is `chrome-extension://…`, so its
 * requests to Canvas are cross-origin: `host_permissions` lifts CORS, and
 * `credentials: "include"` asks Chrome to attach the Canvas cookie it already
 * holds. The extension never reads, copies or stores that cookie. Chrome adds
 * it to the request, the same as for a new Canvas tab.
 *
 * Whether Chrome will is checked before every export, not assumed:
 * `ETHYRA_PROBE_CANVAS` asks Canvas who is signed in, and anything but a user
 * sends the export back to the tab. See `ETHYRA_BEGIN_EXPORT` in background.js.
 *
 * ── What an offscreen page cannot do ──────────────────────────────────
 *
 * It gets only the messaging half of `chrome.runtime` (`sendMessage`,
 * `onMessage`, `id`, `getURL`) and no other `chrome.*`. The shared code calls
 * two things beyond that, both supplied here:
 *
 *   `chrome.runtime.getManifest()`  for the export's `extensionVersion`, in
 *       `run-export.js` and `downloadCourse`. Read from the packaged
 *       manifest.json before an export may start. A missing one threw on the
 *       first line of `runExport`, and the export ended before it began.
 *   `loadSettings()`  reads `chrome.storage.sync`. Ethyra mode ignores the
 *       settings (the first lines of `downloadCourse`), so it returns defaults.
 *
 * Every other `chrome.*` call in that code sits behind `!ethyra` and is never
 * reached here.
 */

// Assigned, not redeclared: `downloader.js` declared it in this same scope.
loadSettings = () => Promise.resolve({ ...SETTING_DEFAULTS });

const manifestReady = fetch(chrome.runtime.getURL("manifest.json"))
  .then((res) => res.json())
  .then((manifest) => {
    chrome.runtime.getManifest ??= () => manifest;
  });

/** The Canvas this export reads. Set by the probe, before any Canvas request. */
let canvasOrigin = null;
let exportInFlight = null;

/**
 * Send the Canvas cookie on requests to Canvas, and only to Canvas.
 *
 * Wrapped here rather than edited into `canvas-api.js` and `archive.js`. Those
 * are shared with the content script, where the requests are same-origin and
 * need nothing. Upstream's files also stay mergeable. Ethyra's API and blob
 * storage are matched out by origin, so they never receive a Canvas cookie.
 */
const pageFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (canvasOrigin && url && url.startsWith(`${canvasOrigin}/`)) {
    return pageFetch(input, { ...init, credentials: "include" });
  }
  return pageFetch(input, init);
};

/**
 * True when Canvas answers with a signed-in user.
 *
 * Checked by the shape of the answer, not only the status: a Canvas that wants a
 * login can answer with a 200 login page after a redirect, and that is a no.
 */
async function canvasKnowsUs(origin) {
  try {
    const res = await fetchWithTimeout(
      `${origin}/api/v1/users/self`,
      { headers: { Accept: "application/json" } },
      10000
    );
    if (!res.ok || !/json/.test(res.headers.get("content-type") || "")) return false;
    const user = await res.json();
    return Boolean(user?.id);
  } catch {
    return false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Every extension context hears every runtime message. This page answers only
  // what is addressed to it, and leaves the rest to the worker.
  if (message?.target !== "offscreen") return false;

  switch (message.type) {
    case "ETHYRA_PROBE_CANVAS":
      canvasOrigin = message.origin;
      canvasKnowsUs(message.origin).then((ok) => sendResponse({ ok }));
      return true;

    case "ETHYRA_RUN_EXPORT":
      if (exportInFlight) {
        sendResponse({ ok: false, error: "An export is still finishing in the background." });
        return false;
      }
      canvasOrigin = message.origin;
      exportInFlight = manifestReady
        .then(() => runExport(message))
        // `runExport` reports its own failures. Anything that escapes it is a
        // bug, and must still end in DONE, or the worker is left waiting for an
        // export that is already over.
        .catch((err) =>
          tellWorker({ type: "ETHYRA_EXPORT_DONE", error: `The export stopped unexpectedly: ${err?.message || err}` })
        )
        .finally(() => {
          exportInFlight = null;
          // After DONE has been acknowledged (`runExport` awaits it): the worker
          // closes this page on this message, and closing it sooner would cut
          // that acknowledgement off.
          chrome.runtime.sendMessage({ type: "ETHYRA_OFFSCREEN_FINISHED" }).catch(() => {});
        });
      sendResponse({ ok: true, started: true });
      return false;

    case "ETHYRA_STATUS":
      sendResponse({ ok: true, exporting: Boolean(exportInFlight) });
      return false;

    default:
      return false;
  }
});
