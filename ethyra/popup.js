/**
 * The popup: sign in, export, watch.
 *
 * Original to this fork. Upstream's `popup.js` is still in the tree and is not
 * loaded — it is a content-type picker for a course mirror this fork does not
 * produce.
 *
 * ── There is nothing to choose ────────────────────────────────────────
 *
 * No course selection, no format, no destination, and no file handed back. One
 * button, and it means "send all of it". A picker would ask a student which of
 * their assignments is worth analysing before anybody — including the analysis —
 * could possibly know.
 *
 * ── The popup is not the process ──────────────────────────────────────
 *
 * It is destroyed whenever it loses focus, which during a long export is nearly
 * always. So it owns no state: every view is rendered from what the service
 * worker reports on open, and progress is polled rather than pushed.
 *
 * ── The popup is also the injector ────────────────────────────────────
 *
 * It is the only place that can be, which is why the manifest declares no
 * `content_scripts` at all — see `CONTENT_SCRIPTS` below.
 */

const POLL_MS = 600;

/**
 * The export bundle, injected on demand. Order matters.
 *
 * ── Why the manifest does not declare these ───────────────────────────
 *
 * Upstream matches every HTTPS host, because a downloader has to put a button on
 * whatever Canvas the user is looking at and self-hosted instances are on
 * arbitrary domains. `detector.js` then decides at runtime, by DOM signals, and
 * that is how self-hosted Canvas is supported here too — the backend has a whole
 * `CANVAS_ORIGINS` setting for those hosts.
 *
 * Inheriting that match pattern meant Chrome injecting this entire bundle into
 * every HTTPS page: banking, email, everything. Nothing ran — `content.js` is
 * one big `if (isCanvas())` — but "nothing ran" is a promise kept by a runtime
 * guard, and PRIVACY.md makes the stronger claim that the extension does not run
 * on non-Canvas sites at all.
 *
 * Narrowing the pattern to `*.instructure.com` would have made that claim true
 * by dropping self-hosted Canvas, which is a supported configuration. So the
 * declaration goes away instead: `activeTab` grants this popup temporary access
 * to the one tab the student had open when they clicked the toolbar icon, for
 * ANY host, and nothing is injected anywhere until that click. The permission
 * table in PRIVACY.md already described this mechanism; now it is the mechanism.
 */
const CONTENT_SCRIPTS = [
  "client-zip.min.js",
  "helpers.js",
  "detector.js",
  "canvas-api.js",
  "ethyra/profile.js",
  "ethyra/manifest.js",
  "downloader.js",
  "ethyra/collect.js",
  "ethyra/archive.js",
  "ethyra/upload.js",
  "ethyra/content.js",
];

/** Set by `content.js` on load, whether or not the page turned out to be Canvas. */
const LOADED_FLAG = "__ethyraContentScriptLoaded";

const els = {};
for (const id of [
  "view-not-canvas", "view-signin", "view-ready", "view-progress", "view-done",
  "email", "password", "signin", "signin-error",
  "who", "signout", "export", "ready-error",
  "progress-label", "progress-bar",
  "done-message", "done-warnings", "done-ok",
]) {
  els[id] = document.getElementById(id);
}

let pollTimer = null;

function show(view) {
  for (const name of ["not-canvas", "signin", "ready", "progress", "done"]) {
    els[`view-${name}`].hidden = name !== view;
  }
}

function fail(el, message) {
  el.textContent = message;
  el.hidden = !message;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/**
 * Ask the content script something.
 *
 * A rejection almost always means there is no content script in that tab — the
 * page is not Canvas, or it was open before the extension was installed and has
 * not been reloaded since. Both are the same instruction to the student.
 */
async function askPage(message) {
  const tab = await activeTab();
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    return null;
  }
}

const askWorker = (message) => chrome.runtime.sendMessage(message);

/**
 * Put the export bundle in the tab, once.
 *
 * The guard is not an optimisation. These files declare top-level `const`s, so
 * evaluating them a second time in the same isolated world throws
 * `SyntaxError: Identifier has already been declared` and takes the listener
 * registered by the first injection down with it — an export that worked on the
 * first popup open and died on the second.
 *
 * Failure here is ordinary rather than exceptional: `chrome://` pages, the Web
 * Store, and a PDF viewer all refuse injection. The caller reads it the same way
 * it reads a failed ping — this tab is not Canvas.
 */
async function ensureContentScript(tabId) {
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (flag) => window[flag] === true,
      args: [LOADED_FLAG],
    });
    if (probe?.result) return true;

    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPTS });
    return true;
  } catch {
    return false;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────

function renderProgress(state) {
  const { phase } = state;
  let label = "Working…";
  let fraction = null;

  if (phase === "collecting") {
    label = state.course ? `Reading ${state.course}…` : "Reading your courses…";
    if (state.total) fraction = (state.index || 0) / state.total;
  } else if (phase === "archiving") {
    label = state.current ? `Packaging ${state.current}…` : "Packaging…";
    if (state.total) fraction = (state.completed || 0) / state.total;
  } else if (phase === "uploading") {
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    label = state.total ? `Uploading ${mb(state.loaded)} of ${mb(state.total)} MB…` : "Uploading…";
    if (state.total) fraction = state.loaded / state.total;
  } else if (phase === "uploaded") {
    label = "Uploaded — Ethyra is reading it now.";
    fraction = 1;
  }

  els["progress-label"].textContent = label;
  // An indeterminate phase leaves the bar where it was rather than snapping to
  // zero, which reads as the export having restarted.
  if (fraction !== null) {
    els["progress-bar"].style.width = `${Math.min(100, Math.round(fraction * 100))}%`;
  }
}

function renderDone(state) {
  if (state.error) {
    els["done-message"].className = "error";
    els["done-message"].textContent = state.error;
  } else {
    els["done-message"].className = "ok";
    els["done-message"].textContent =
      "Sent. Ethyra is analysing your work — open the web app to watch your graph fill in.";
  }
  els["done-warnings"].replaceChildren();
  for (const warning of state.warnings || []) {
    const li = document.createElement("li");
    li.textContent = warning;
    els["done-warnings"].appendChild(li);
  }
}

// ── Polling ──────────────────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const session = await askWorker({ type: "ETHYRA_GET_SESSION" });
    const state = session?.export || { status: "idle" };
    if (state.status === "running") {
      renderProgress(state);
      return;
    }
    stopPolling();
    if (state.status === "idle") {
      await showReady(session);
    } else {
      renderDone(state);
      show("done");
    }
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ── Views ────────────────────────────────────────────────────────────────

async function showReady(session) {
  // The export reads Canvas from the page, so the tab has to be one. Nothing is
  // in the page until this line — the click that opened this popup is what
  // grants access to that tab, and to no other.
  const tab = await activeTab();
  if (tab?.id) await ensureContentScript(tab.id);

  // The bundle loads everywhere it is injected; `content.js` answers a ping only
  // when `isCanvas()` held. So silence still means "not Canvas", exactly as it
  // did when the manifest decided where to inject.
  const alive = await askPage({ type: "ETHYRA_PING" });
  if (!alive?.ok) {
    show("not-canvas");
    return;
  }
  els.who.textContent = session?.user?.email || "Signed in";
  els.export.disabled = false;
  fail(els["ready-error"], "");
  show("ready");
}

async function boot() {
  const session = await askWorker({ type: "ETHYRA_GET_SESSION" });
  const exportState = session?.export || { status: "idle" };

  if (exportState.status === "running") {
    renderProgress(exportState);
    show("progress");
    startPolling();
    return;
  }
  if (exportState.status === "done" || exportState.status === "failed") {
    renderDone(exportState);
    show("done");
    return;
  }
  if (!session?.user) {
    show("signin");
    return;
  }
  await showReady(session);
}

// ── Wiring ───────────────────────────────────────────────────────────────

els.signin.addEventListener("click", async () => {
  fail(els["signin-error"], "");
  els.signin.disabled = true;
  els.signin.textContent = "Signing in…";
  try {
    const result = await askWorker({
      type: "ETHYRA_SIGN_IN",
      email: els.email.value.trim(),
      password: els.password.value,
    });
    if (!result?.ok) throw new Error(result?.error || "Sign-in failed.");
    await showReady({ user: result.user });
  } catch (err) {
    fail(els["signin-error"], err.message);
  } finally {
    els.signin.disabled = false;
    els.signin.textContent = "Sign in";
  }
});

els.password.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.signin.click();
});

els.signout.addEventListener("click", async () => {
  await askWorker({ type: "ETHYRA_SIGN_OUT" });
  show("signin");
});

els.export.addEventListener("click", async () => {
  fail(els["ready-error"], "");
  els.export.disabled = true;

  const begun = await askWorker({ type: "ETHYRA_BEGIN_EXPORT" });
  if (!begun?.ok) {
    fail(els["ready-error"], begun?.error || "Could not start the export.");
    els.export.disabled = false;
    return;
  }

  const started = await askPage({
    type: "ETHYRA_RUN_EXPORT",
    apiUrl: begun.apiUrl,
    accessToken: begun.accessToken,
  });

  if (!started?.ok) {
    // Clear the worker's "running" flag, or the popup reopens to a progress bar
    // for an export that never began.
    await askWorker({ type: "ETHYRA_CLEAR_EXPORT" });
    fail(els["ready-error"], started?.error || "Could not start the export in this tab.");
    els.export.disabled = false;
    return;
  }

  show("progress");
  startPolling();
});

els["done-ok"].addEventListener("click", async () => {
  await askWorker({ type: "ETHYRA_CLEAR_EXPORT" });
  await boot();
});

boot();
