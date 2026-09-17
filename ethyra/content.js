/**
 * The export, run inside the Canvas page.
 *
 * Original to this fork. Upstream's `content.js` is still in the tree and is not
 * loaded — it injects the in-page download button and panel, which this fork
 * replaced with the popup.
 *
 * ── Why any of this happens in the page ───────────────────────────────
 *
 * Because that is where the Canvas session cookie is. A content script's
 * `fetch` to `/api/v1/...` is same-origin and authenticated by default; the same
 * request from the service worker is not, and making it work would mean reading
 * cookies the extension has no business holding.
 *
 * The upload happens here too, rather than being handed back to the worker, for
 * a blunter reason: a 300 MB Blob does not survive `chrome.runtime.sendMessage`,
 * and the two contexts share no storage to pass it through. The cost is that the
 * upload's `Origin` is the Canvas host, which the backend's allowlist has to
 * admit — see `upload.js`.
 *
 * ── The tab is the process ────────────────────────────────────────────
 *
 * A content script dies when its page navigates. A student who clicks a Canvas
 * link mid-export kills it, so `beforeunload` warns them while one is running.
 * That is a real limitation of doing the work here and not one this fork can
 * engineer away.
 */

if (isCanvas()) {
  let exportInFlight = null;

  const report = (progress) => {
    chrome.runtime.sendMessage({ type: "ETHYRA_EXPORT_PROGRESS", progress }).catch(() => {
      // The popup may be closed and the worker asleep. Progress is advisory;
      // losing a frame of it must never stop an export.
    });
  };

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
      sendResponse({ ok: true, host: window.location.host });
      return false;
    }

    if (message?.type === "ETHYRA_RUN_EXPORT") {
      if (exportInFlight) {
        sendResponse({ ok: false, error: "An export is already running in this tab." });
        return false;
      }
      exportInFlight = runExport(message).finally(() => {
        exportInFlight = null;
      });
      // Answered immediately: the export outlives the popup, and progress
      // arrives through the worker rather than through this reply.
      sendResponse({ ok: true, started: true });
      return false;
    }

    return false;
  });

  /**
   * Collect, archive, upload.
   *
   * Every failure lands in ETHYRA_EXPORT_DONE with a sentence a student can
   * act on, because by the time one happens the popup is probably closed and
   * this is the only record they will see.
   */
  async function runExport({ apiUrl, accessToken, studentName }) {
    const origin = window.location.origin;
    const extensionVersion = chrome.runtime.getManifest().version;

    try {
      report({ phase: "collecting" });
      const { manifest, files, warnings } = await collectExport({
        origin,
        extensionVersion,
        onProgress: report,
      });

      if (!manifest.courses.length) {
        throw new Error("No submitted work was found in your Canvas courses.");
      }

      report({ phase: "archiving", completed: 0, total: files.length + 1 });
      const { blob, failed } = await buildArchive(files, manifest, { onProgress: report });
      if (failed.length) {
        warnings.push(`${failed.length} file(s) could not be downloaded from Canvas and were left out.`);
      }

      report({ phase: "uploading", loaded: 0, total: blob.size });
      const upload = await uploadArchive({
        apiUrl,
        accessToken,
        blob,
        studentName,
        onProgress: report,
      });

      chrome.runtime.sendMessage({
        type: "ETHYRA_EXPORT_DONE",
        uploadId: upload?.id || null,
        warnings,
      });
    } catch (err) {
      console.error("[Ethyra] Export failed:", err);
      chrome.runtime.sendMessage({
        type: "ETHYRA_EXPORT_DONE",
        error: err?.message || String(err),
      });
    }
  }
}
