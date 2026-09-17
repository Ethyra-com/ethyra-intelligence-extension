/**
 * Send the archive to Ethyra.
 *
 * Original to this fork.
 *
 * ── One endpoint, both ingest paths ───────────────────────────────────
 *
 * `POST /api/act/uploads` is the same endpoint a student uses to upload a Canvas
 * personal export by hand. The backend branches once, on whether the archive
 * contains `ethyra-manifest.json`, and everything after that branch — dedupe by
 * content hash, the already-seen skip, extraction, the analysis run — is shared.
 *
 * That is what makes the two paths one profile: a student who exported by hand
 * in January and with this extension in March is not re-measured on the files
 * that did not change.
 *
 * ── XHR, not fetch ────────────────────────────────────────────────────
 *
 * `fetch` cannot report upload progress. A 300 MB archive over school wifi is
 * minutes of a progress bar that would otherwise sit at zero and then jump, and
 * the web app made the same choice for the same reason.
 *
 * ── Where this runs, and why it is a CORS problem ─────────────────────
 *
 * In the content script, so the collection and the upload share one context and
 * a 300 MB Blob never has to cross `chrome.runtime.sendMessage` — which has
 * practical size limits, and whose two sides do not share storage either.
 *
 * The cost is that the request's `Origin` is the Canvas page's, e.g.
 * `https://school.instructure.com`. The backend's allowlist has to admit it.
 * The access token is passed in from the service worker only when the student
 * clicks Export and is never stored anywhere a page can read, so a hostile
 * Canvas page cannot obtain one — but the allowlist entry is real and should be
 * a pattern over Canvas hosts, never `*`.
 */

/** Matches the web app's field names — the endpoint is shared, so the form is too. */
function buildForm(blob, studentName) {
  const form = new FormData();
  form.append("file", blob, "ethyra-canvas-export.zip");
  if (studentName) form.append("student_name", studentName);
  return form;
}

/**
 * Upload, reporting progress.
 *
 * Resolves with the created upload row. Rejects with the backend's own message
 * where there is one: a 503 here means the ACT standards are not loaded, which
 * is an operator problem and not something a student should see as "failed".
 */
function uploadArchive({ apiUrl, accessToken, blob, studentName, signal, onProgress = () => {} }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiUrl}/api/act/uploads`);
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    // Deliberately no Content-Type: the browser has to set the multipart
    // boundary itself, and setting it by hand produces a body the server
    // cannot parse.

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress({ phase: "uploading", loaded: event.loaded, total: event.total });
    };

    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // A non-JSON body means a proxy or a crash, not an API error.
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress({ phase: "uploaded" });
        resolve(body);
        return;
      }
      reject(new Error(body.detail || body.message || describeFailure(xhr.status)));
    };

    xhr.onerror = () =>
      reject(
        new Error(
          "Could not reach Ethyra. If you are on a school network it may be blocked; " +
            "otherwise check that you are signed in."
        )
      );
    xhr.ontimeout = () => reject(new Error("The upload timed out."));

    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));

    xhr.send(buildForm(blob, studentName));
  });
}

/** A sentence a student can act on, for the statuses the backend actually returns. */
function describeFailure(status) {
  switch (status) {
    case 401:
      return "Your Ethyra session has expired. Sign in again and retry.";
    case 413:
      return "That export is larger than Ethyra's 500 MB limit. Deselect a course and try again.";
    case 429:
      return "Too many uploads in a short time. Wait a minute and try again.";
    case 503:
      return "Ethyra is not ready to accept uploads right now. Try again shortly.";
    default:
      return `Upload failed (${status}).`;
  }
}
