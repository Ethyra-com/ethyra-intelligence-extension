/**
 * Send the archive to Ethyra.
 *
 * Original to this fork.
 *
 * ── Each file straight to blob storage, as each course is read ──────
 *
 * A student with every past course has 1-2 GB of work, and most of it was sent
 * last time. So nothing is zipped. As each course is collected:
 *
 *   1. Its files are fetched from Canvas a few at a time, while the download
 *      links are fresh, and hashed (SHA-256).
 *   2. `POST /api/act/uploads/files` with the hashes answers with a write URL
 *      for each file this student has never sent. The rest are skipped.
 *   3. Each new file is PUT to its URL, retried on its own if it fails.
 *
 * Then `POST /api/act/uploads/complete` sends the manifest — every file named by
 * its hash — and the backend reads the files from the student's store.
 *
 * A backend without `/files` (not yet deployed, or unable to sign URLs) is found
 * out on the first course, before anything is sent, and the export falls back to
 * one zip in one request, which works up to that route's 500 MB limit.
 *
 * ── Where this runs, and why it is a CORS problem ─────────────────────
 *
 * In the content script, so the collection and the upload share one context and
 * a 300 MB Blob never has to cross `chrome.runtime.sendMessage` — which has
 * practical size limits, and whose two sides do not share storage either.
 *
 * The cost is that the request's `Origin` is the Canvas page's, e.g.
 * `https://school.instructure.com`. The backend's allowlist has to admit it, and
 * so does the storage account's CORS for the block PUTs (see the README).
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

const FILE_CONCURRENCY = 4;
const RETRY_ATTEMPTS = 5;
// Files fetched and hashed before asking which are new. Bounded by count and by
// bytes: one course was 263 MB, and holding a course whole is what this avoids.
const BATCH_FILES = 8;
const BATCH_BYTES = 64 * 1024 * 1024;

const UNREACHABLE =
  "Could not reach Ethyra. If you are on a school network it may be blocked; " +
  "otherwise check that you are signed in.";

/**
 * Sends each course's files as it is collected. `mode` is "files" until the
 * first request finds a backend without the route, then "zip" for good.
 */
function createFileSender({ apiUrl, accessToken, signal, onProgress = () => {} }) {
  const sender = { mode: "files", sent: 0, skipped: 0, sendCourse };

  async function sendCourse({ course, files, index, total }) {
    const hashes = new Map();
    const failed = [];
    if (sender.mode === "zip") return { failed, hashes: null };

    for (const batch of batches(files)) {
      const fetched = await mapLimit(batch, FILE_CONCURRENCY, async (file) => {
        const path = `${file.path}${file.filename}`;
        try {
          const bytes = await fetchFileBytes(file, signal);
          return { path, bytes, sha256: await sha256Hex(bytes) };
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          console.warn(`[Ethyra] Could not fetch ${path}:`, err);
          failed.push(path);
          return null;
        }
      });
      const ok = fetched.filter(Boolean);
      if (!ok.length) continue;

      const urls = await requestFileUrls({ apiUrl, accessToken, signal, files: ok });
      if (urls === null) {
        sender.mode = "zip";
        return { failed: [], hashes: null };
      }

      await mapLimit(ok, FILE_CONCURRENCY, async (f) => {
        hashes.set(f.path, { sha256: f.sha256, size: f.bytes.byteLength });
        const url = urls[f.sha256];
        if (url) {
          // Claimed before the PUT, not after: the same bytes twice in one
          // batch are sent once, and the second worker must not see the URL.
          urls[f.sha256] = null;
          await withRetry(() => putFile(url, f.bytes, signal), signal);
          sender.sent++;
        } else {
          sender.skipped++;
        }
        f.bytes = null;
      });
      onProgress({ phase: "sending", course, index, total, sent: sender.sent, skipped: sender.skipped });
    }
    return { failed, hashes };
  }

  return sender;
}

function* batches(files) {
  let batch = [];
  let bytes = 0;
  for (const file of files) {
    if (batch.length && (batch.length >= BATCH_FILES || bytes + (file.size || 0) > BATCH_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.size || 0;
  }
  if (batch.length) yield batch;
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Write URLs for the files not yet sent, or null for a backend that cannot
 * take them — 404 without the route, 501 unable to sign, or a failed preflight
 * (its CORS allowlist does not name the path), which arrives as unreachable.
 */
async function requestFileUrls({ apiUrl, accessToken, signal, files }) {
  try {
    const res = await callApi(`${apiUrl}/api/act/uploads/files`, {
      accessToken,
      signal,
      body: { files: files.map((f) => ({ sha256: f.sha256, size: f.bytes.byteLength })) },
    });
    return res.upload || {};
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    if (err?.status === 404 || err?.status === 501 || err?.status === undefined) {
      console.info("[Ethyra] Per-file upload unavailable, sending one zip instead:", err?.message);
      return null;
    }
    throw err;
  }
}

/** One file, one PUT. Sending the same bytes again just rewrites them. */
function putFile(url, bytes, signal) {
  return putToStorage(url, bytes, { "x-ms-blob-type": "BlockBlob" }, signal);
}

/** The manifest, once every file it names is stored. Resolves with the upload row. */
async function completeUpload({ apiUrl, accessToken, manifest, studentName, signal }) {
  return callApi(`${apiUrl}/api/act/uploads/complete`, {
    accessToken,
    signal,
    body: { upload_id: crypto.randomUUID(), manifest, student_name: studentName || null },
  });
}

/**
 * A JSON POST to the backend. Errors carry `status`, or none when unreachable.
 *
 * `accessToken` may be a function returning one, asked for on every call: an
 * export runs longer than a token lives.
 */
async function callApi(url, { accessToken, signal, body }) {
  const token = typeof accessToken === "function" ? await accessToken() : accessToken;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new Error(UNREACHABLE);
  }
  let json = {};
  try {
    json = await res.json();
  } catch {
    // A non-JSON body means a proxy or a crash, not an API error.
  }
  if (!res.ok) {
    const err = new Error(json.detail || json.message || describeFailure(res.status));
    err.status = res.status;
    throw err;
  }
  return json;
}

async function putToStorage(url, body, headers, signal) {
  let res;
  try {
    res = await fetch(url, { method: "PUT", body, headers, signal });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    const wrapped = new Error("Lost the connection to Ethyra's storage while uploading.");
    wrapped.retryable = true;
    throw wrapped;
  }
  if (res.ok) return;
  const err = new Error(
    res.status === 403
      ? "The upload took too long and its permission expired. Export again to retry."
      : `Upload to storage failed (${res.status}).`
  );
  err.status = res.status;
  err.retryable = res.status === 408 || res.status === 429 || res.status >= 500;
  throw err;
}

/** Retry what can succeed on a second try, backing off 1, 2, 4, 8 seconds. */
async function withRetry(attempt, signal) {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (!err?.retryable || n >= RETRY_ATTEMPTS || signal?.aborted) throw err;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1000 * 2 ** (n - 1));
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true }
        );
      });
    }
  }
}

/**
 * The single-request upload, for a backend without `begin`.
 *
 * XHR, not fetch: `fetch` cannot report upload progress, and a few hundred MB
 * with a bar that sits at zero reads as a hang.
 */
function uploadMultipart({ apiUrl, accessToken, blob, studentName, signal, onProgress = () => {} }) {
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

    xhr.onerror = () => reject(new Error(UNREACHABLE));
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

/**
 * What went wrong, for the statuses the backend actually returns.
 *
 * Each one either names an action the student can take or says plainly that
 * there isn't one. A message that suggests something impossible is worse than a
 * bare status code: it sends someone looking for a control that does not exist
 * and leaves them thinking they did it wrong.
 *
 * The 413 case is the one that got this wrong — it told students to deselect a
 * course, wording left over from a popup that briefly had a course picker. This
 * export has none: every enrolment goes, every time.
 */
function describeFailure(status) {
  switch (status) {
    case 401:
      return "Your Ethyra session has expired. Sign in again and retry.";
    case 413:
      return (
        "Your coursework is over Ethyra's size limit, so it was not accepted. " +
        "This is a limit on our side rather than anything you can change — please let Ethyra know."
      );
    case 429:
      return "Too many uploads in a short time. Wait a minute and try again.";
    case 503:
      return "Ethyra is not ready to accept uploads right now. Try again shortly.";
    default:
      return `Upload failed (${status}).`;
  }
}
