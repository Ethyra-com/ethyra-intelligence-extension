/**
 * The export itself: collect, then send. Shared by both places it can run.
 *
 * Original to this fork. It used to live inside `content.js`, which made the
 * Canvas tab the only place an export could run — and closing that tab ended it.
 * It now runs in one of two places, and this file is loaded by both:
 *
 *   ethyra/offscreen.html   The usual case. An extension page with no tab, so a
 *                           student can close Canvas and the export carries on.
 *   ethyra/content.js       The fallback, inside the Canvas tab, for a Canvas
 *                           the offscreen page cannot reach — see
 *                           `ETHYRA_BEGIN_EXPORT` in background.js.
 *
 * `origin` is passed in rather than read from `window.location`, because in the
 * offscreen page `window.location` is the extension, not Canvas. That page also
 * lacks most of `chrome.*`; see the header of `offscreen.js` for what it adds.
 */

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

/**
 * Collect, archive, upload.
 *
 * Every failure lands in ETHYRA_EXPORT_DONE with a sentence a student can
 * act on, because by the time one happens the popup is probably closed and
 * this is the only record they will see.
 */
async function runExport({ apiUrl, accessToken: firstToken, studentName, origin }) {
  // Asked for before every call: the export outlives the token it started
  // with. Falls back to that one if the worker cannot answer, so an expired
  // session still reaches the backend and comes back as its own 401 message.
  const accessToken = async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: "ETHYRA_GET_TOKEN" });
      if (res?.accessToken) return res.accessToken;
    } catch {
      // The worker is restarting; the token we have may still be good.
    }
    return firstToken;
  };
  const extensionVersion = chrome.runtime.getManifest().version;

  // Minted here rather than at `/complete`, so the progress the web app shows
  // while collecting and the upload that replaces it share one id.
  const uploadId = crypto.randomUUID();
  const exportProgress = createExportReporter({ apiUrl, accessToken, uploadId });
  // Every frame to the popup, and to Ethyra for the web app's first step.
  const progress = (frame) => {
    report(frame);
    exportProgress.update(frame);
  };

  try {
    progress({ phase: "collecting" });
    // Each course's files go to Ethyra as soon as that course is collected,
    // while its Canvas download links are fresh, and only the ones this
    // student has never sent. See `createFileSender`.
    const sender = createFileSender({
      apiUrl,
      accessToken,
      maxTotalBytes: ETHYRA_MAX_TOTAL_BYTES,
      onProgress: progress,
    });
    const { manifest, files, warnings, totalBytes } = await collectExport({
      origin,
      extensionVersion,
      onProgress: progress,
      sendCourse: sender.sendCourse,
    });
    await exportProgress.collected();

    if (!manifest.courses.length) {
      throw new Error("No submitted work was found in your Canvas courses.");
    }

    let upload;
    if (sender.mode === "zip") {
      // A backend without the per-file routes: one archive, one request, and
      // that route's far smaller cap. Refused before anything is fetched when
      // Canvas's sizes already say it will not fit; `buildArchive` enforces
      // the same cap on the real bytes as it builds.
      const mb = Math.round(ETHYRA_MAX_ZIP_BYTES / (1024 * 1024));
      if (totalBytes > ETHYRA_MAX_ZIP_BYTES) {
        throw new Error(
          `Your coursework comes to about ${Math.round(totalBytes / (1024 * 1024))} MB, over the ${mb} MB ` +
            "this Ethyra server takes in one upload, so nothing was uploaded. " +
            "This is a limit on our side rather than anything you can change — please let Ethyra know."
        );
      }
      report({ phase: "archiving", completed: 0, total: files.length + 1 });
      const { blob, failed } = await buildArchive(files, manifest, {
        maxBytes: ETHYRA_MAX_ZIP_BYTES,
        onProgress: report,
      });
      if (failed.length) {
        warnings.push(`${failed.length} file(s) could not be downloaded from Canvas and were left out.`);
      }
      report({ phase: "uploading", loaded: 0, total: blob.size });
      upload = await uploadMultipart({
        apiUrl,
        accessToken: await accessToken(),
        blob,
        studentName,
        onProgress: report,
      });
      // That upload has an id of its own, so `/complete` never takes this
      // export's place: say it is over, or the web app shows it until it goes
      // stale.
      exportProgress.end("done");
    } else {
      upload = await completeUpload({ apiUrl, accessToken, uploadId, manifest, studentName });
      report({ phase: "uploaded" });
    }

    // Awaited and retried — see `tellWorker`. Losing this leaves the popup on
    // a progress bar for an upload that has already landed.
    await tellWorker({
      type: "ETHYRA_EXPORT_DONE",
      uploadId: upload?.id || null,
      warnings,
    });
  } catch (err) {
    console.error("[Ethyra] Export failed:", err);
    exportProgress.end("failed");
    await tellWorker({
      type: "ETHYRA_EXPORT_DONE",
      error: err?.message || String(err),
    });
  }
}
