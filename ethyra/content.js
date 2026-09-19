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

window.__ethyraContentScriptLoaded = true;

if (isCanvas()) {
  let exportInFlight = null;

  /**
   * The archive that was just uploaded, kept so the student can save a copy.
   *
   * ── Why it is kept here, and what that costs ──────────────────────
   *
   * "Download a copy of what was sent" has to hand over the SAME bytes that
   * were sent, or it answers a different question than the one asked. Rebuilding
   * it would re-fetch every file from Canvas — minutes of work, and the second
   * archive could legitimately differ from the first, since attachment URLs
   * expire and an assignment can be resubmitted in between.
   *
   * So the Blob stays. That is up to `ETHYRA_MAX_TOTAL_BYTES` of memory held in
   * the page after the upload has finished, which is a real cost and the reason
   * this is a deliberate reference rather than an accident of scope.
   *
   * It dies with the page, like everything else here, and the popup says so
   * rather than offering a button that fails.
   */
  let lastArchive = null;

  const report = (progress) => {
    chrome.runtime.sendMessage({ type: "ETHYRA_EXPORT_PROGRESS", progress }).catch(() => {
      // The popup may be closed and the worker asleep. Progress is advisory;
      // losing a frame of it must never stop an export.
    });
  };

  /**
   * Tell the worker something that must not be lost, and keep trying.
   *
   * ── Why progress can be dropped and this cannot ───────────────────
   *
   * A lost progress frame costs a stale number for 600ms. A lost
   * `ETHYRA_EXPORT_DONE` costs the whole export: the state stays `running`
   * forever, the popup renders a progress bar for an upload that finished
   * minutes ago, and nothing will ever move it — which is exactly what
   * "stuck on the upload, never says it is analysing" was.
   *
   * It is a real failure mode rather than a theoretical one. MV3 kills an idle
   * service worker within seconds, and a multi-minute upload is all idle from
   * the worker's point of view. `sendMessage` is supposed to wake it, and
   * mostly does — but a message sent while it is being torn down is lost, which
   * is what "the message channel closed before a response was received" in the
   * page console was reporting all along.
   *
   * The original send was not even awaited, so its rejection was an unhandled
   * promise rejection that the surrounding `try/catch` never saw. It failed
   * silently, by construction.
   *
   * Every branch the worker answers replies `{ok: true}`, so acknowledgement is
   * observable rather than assumed.
   */
  async function tellWorker(message, { attempts = 8 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      // An invalidated context means the extension was reloaded or updated
      // underneath this page. Nothing is listening and nothing will be, so
      // retrying is just a slower way to fail.
      if (!chrome.runtime?.id) return null;
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (response?.ok) return response;
      } catch {
        // Worker asleep, restarting, or torn down mid-reply. All retryable.
      }
      // 250ms, 500ms, 1s, 2s, then 2s — about 11 seconds in total, which is far
      // longer than a worker takes to come back and short enough that a student
      // watching the popup does not out-wait it.
      const backoff = 250 * Math.min(2 ** attempt, 8);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
    console.error("[Ethyra] The worker never acknowledged:", message.type);
    return null;
  }

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

    /**
     * Save a copy of the archive that was uploaded.
     *
     * Done here rather than through `chrome.downloads` because the bytes are
     * here: an object URL minted in the page is downloadable from the page, and
     * handing a 300 MB Blob to the worker to do it instead is the same problem
     * `upload.js` avoids.
     */
    if (message?.type === "ETHYRA_DOWNLOAD_ARCHIVE") {
      if (!lastArchive) {
        sendResponse({
          ok: false,
          error:
            "The copy is held in this tab and is gone — it is cleared when the page reloads. Export again to save one.",
        });
        return false;
      }
      try {
        const url = URL.createObjectURL(lastArchive.blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = lastArchive.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Not revoked immediately: Chrome reads the URL asynchronously after the
        // click, and revoking in the same turn cancels the download it just
        // started. A minute is far longer than it needs and costs nothing.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
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

      // Held before the upload, not after: an upload that fails is exactly when
      // a student most wants the copy, and a failure never reaches the line
      // below it.
      lastArchive = {
        blob,
        filename: `ethyra-canvas-export-${new Date().toISOString().slice(0, 10)}.zip`,
      };

      report({ phase: "uploading", loaded: 0, total: blob.size });
      const upload = await uploadArchive({
        apiUrl,
        accessToken,
        blob,
        studentName,
        onProgress: report,
      });

      // Awaited and retried — see `tellWorker`. Losing this leaves the popup on
      // a progress bar for an upload that has already landed.
      await tellWorker({
        type: "ETHYRA_EXPORT_DONE",
        uploadId: upload?.id || null,
        warnings,
      });
    } catch (err) {
      console.error("[Ethyra] Export failed:", err);
      await tellWorker({
        type: "ETHYRA_EXPORT_DONE",
        error: err?.message || String(err),
      });
    }
  }
}
