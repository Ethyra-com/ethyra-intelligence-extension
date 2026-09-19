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
 * How often to ask how the analysis is going, and how long to wait for it to
 * start at all. Both match `LearningGraphPlaygroundPage` in the frontend.
 *
 * ── Why not `POLL_MS` ─────────────────────────────────────────────────
 *
 * 600ms is right for the export: it is local, it moves continuously, and the
 * only cost of asking is a message to a worker in the same browser.
 *
 * The analysis is neither. It advances one assignment at a time over minutes,
 * and every poll is an authenticated request that loads every analysis the
 * student owns and builds a payload for each. At 600ms that is a hundred of
 * them a minute, for a number that changes maybe ten times in total — which is
 * what the backend log showed: `GET /api/act/runs` scrolling continuously
 * underneath the agent calls it was competing with.
 */
const ANALYSIS_POLL_MS = 4000;

/**
 * Stop waiting for a run that never appeared.
 *
 * The backend opens the run asynchronously after the upload returns, so a few
 * empty polls at the start are normal. An unbounded number is not: if the run
 * fails to open, this view would otherwise say "Reading your work" forever
 * about work nothing is reading.
 *
 * 30 × 4s = two minutes, the same budget the web app allows.
 */
const ANALYSIS_STARTUP_POLLS = 30;

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
  "view-not-canvas", "view-signin", "view-signup", "view-ready", "view-progress", "view-done",
  "email", "password", "signin", "signin-error", "go-signup",
  "signup-first", "signup-last", "signup-email", "signup-password", "signup-terms",
  "signup", "signup-error", "go-signin",
  "who", "signout", "export", "ready-error",
  "progress-label", "progress-bar", "progress-cancel",
  "view-analyzing", "analysis-label", "analysis-bar", "analysis-detail",
  "analysis-open", "analysis-download", "analysis-error", "analysis-close",
  "done-message", "done-warnings", "done-ok",
]) {
  els[id] = document.getElementById(id);
}

let pollTimer = null;

function show(view) {
  for (const name of ["not-canvas", "signin", "signup", "ready", "progress", "analyzing", "done"]) {
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

/** A run the backend has settled, by its own vocabulary. See `RUN_TERMINAL`. */
const RUN_TERMINAL = new Set(["ready", "partial", "failed"]);

/**
 * The analysis, while it runs.
 *
 * Mirrors `RunProgress` in the frontend, down to the wording. Two of its
 * distinctions are load-bearing and easy to lose:
 *
 *   `unchanged` is not `skipped`. On a bar they look the same and they mean
 *   opposite things — "you had already been measured on this, so it cost
 *   nothing" against "this was new and could not be measured". Collapsing them
 *   tells a returning student most of their work was ignored.
 *
 *   The bar counts ASSIGNMENTS, not files or agent calls. `calls_done` moves
 *   more smoothly and would make a prettier bar, but it counts a unit the
 *   student never gave us and cannot check.
 */
function renderAnalysis(run) {
  if (!run) {
    // No run yet — the upload landed and the backend has not opened one, or a
    // poll failed. Both are "still working", not "finished"; saying anything
    // more definite would be inventing a state.
    els["analysis-label"].textContent = "Reading your work…";
    els["analysis-detail"].hidden = true;
    return;
  }

  const done = run.assignments_done ?? 0;
  const total = run.assignments_total ?? 0;
  const unchanged = run.counts?.unchanged ?? 0;

  els["analysis-label"].textContent = total
    ? `Reading your work — ${done} of ${total} assignments`
    : "Reading your work…";

  if (total) {
    els["analysis-bar"].style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
  }

  const detail = [];
  if (run.new_artifact_count > 0) {
    detail.push(`${run.new_artifact_count} new ${run.new_artifact_count === 1 ? "file" : "files"}`);
    if (run.unchanged_artifact_count > 0) {
      detail.push(`${run.unchanged_artifact_count} already measured`);
    }
  }
  if (unchanged > 0) {
    detail.push(
      `${unchanged} ${unchanged === 1 ? "assignment" : "assignments"} unchanged since your last upload`
    );
  }
  els["analysis-detail"].textContent = detail.join(" · ");
  els["analysis-detail"].hidden = detail.length === 0;
}

function renderDone(state) {
  if (state.error) {
    els["done-message"].className = "lp-auth-error";
    els["done-message"].textContent = state.error;
  } else if (state.run?.status === "failed") {
    // The upload succeeded and the analysis did not. Saying "sent" and stopping
    // there would be true and useless — the student would wait for a graph that
    // is never going to fill in.
    els["done-message"].className = "lp-auth-error";
    els["done-message"].textContent =
      "Your work was uploaded, but Ethyra could not finish reading it. Open the web app for details.";
  } else if (state.run) {
    const done = state.run.assignments_done ?? 0;
    const total = state.run.assignments_total ?? 0;
    // `partial` is a success with casualties — some assignments failed and the
    // rest committed. The student has results either way, so it is not an
    // error, but the count has to be honest about the gap rather than
    // reporting the total as though it all landed.
    els["done-message"].className = "lp-ok";
    els["done-message"].textContent =
      state.run.status === "partial" && total && done < total
        ? `Read ${done} of ${total} assignments — the rest could not be measured. Open the web app to see your graph.`
        : `Read ${done === total ? "all " : ""}${done} ${done === 1 ? "assignment" : "assignments"}. Open the web app to see your graph.`;
  } else {
    els["done-message"].className = "lp-ok";
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
    if (state.status === "analyzing") {
      // Hand off to the slower poller — this one runs at the export's cadence,
      // which is a hundred requests a minute at a number that changes ten times.
      stopPolling();
      startAnalysisPolling();
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

/**
 * Watch the analysis, at the pace the analysis actually moves.
 *
 * Shares `pollTimer` with `startPolling`, so `stopPolling` ends either and the
 * two can never run at once — which would double the request rate this exists
 * to bring down.
 */
function startAnalysisPolling() {
  stopPolling();
  show("analyzing");

  let waitingForRun = 0;

  pollTimer = setInterval(async () => {
    const { run } = (await askWorker({ type: "ETHYRA_GET_RUN" })) || {};
    renderAnalysis(run);

    if (!run) {
      // The backend opens the run after the upload returns, so a few empty
      // polls are normal at the start. An unbounded number is not.
      if (++waitingForRun < ANALYSIS_STARTUP_POLLS) return;
      stopPolling();
      // Finished with no run attached, so the done view falls back to "Ethyra
      // is analysing your work" — which remains true. Nothing here knows the
      // run failed; it knows only that it never appeared, and saying more than
      // that would be inventing an outcome.
      await askWorker({ type: "ETHYRA_FINISH_ANALYSIS", run: null });
      await boot();
      return;
    }

    // A run that appeared resets the budget: the wait was for it to exist, and
    // it does.
    waitingForRun = 0;

    // Only a run the backend has settled ends this. An empty poll is not an
    // ending — the request may simply have failed — and treating one as
    // "finished" would tell the student their analysis was complete when it had
    // not started.
    if (RUN_TERMINAL.has(run.status)) {
      stopPolling();
      await askWorker({ type: "ETHYRA_FINISH_ANALYSIS", run });
      await boot();
    }
  }, ANALYSIS_POLL_MS);
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
  // Reopening mid-analysis lands back here. The run is server-side, so whatever
  // happened while the popup was shut is simply read back on the next poll.
  if (exportState.status === "analyzing") {
    renderAnalysis(null);
    startAnalysisPolling();
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

// ── Sign-up ──────────────────────────────────────────────────────────────
//
// Both links clear the error on the view being LEFT. Carrying "that password is
// wrong" across to the other form describes a form the student is no longer
// looking at.

els["go-signup"].addEventListener("click", (e) => {
  e.preventDefault();
  fail(els["signin-error"], "");
  els["signup-email"].value = els.email.value.trim();
  show("signup");
  // First name, not email — it is the first field on this form, and focusing
  // the middle of a form skips past two boxes the student still has to fill.
  els["signup-first"].focus();
});

els["go-signin"].addEventListener("click", (e) => {
  e.preventDefault();
  fail(els["signup-error"], "");
  els.email.value = els["signup-email"].value.trim();
  show("signin");
  els.email.focus();
});

els.signup.addEventListener("click", async () => {
  fail(els["signup-error"], "");

  const firstName = els["signup-first"].value.trim();
  const lastName = els["signup-last"].value.trim();

  /**
   * Both names are required, and that requirement lives HERE alone today.
   *
   * `SignUpRequest` in the backend still declares `first_name` and `last_name`
   * as `Optional[str] = None`, because the web app has always sent them that
   * way. So this is a client-side rule over a permissive endpoint: a caller
   * that is not this popup can still create a nameless account, and the web
   * app currently does.
   *
   * That is a gap rather than a design. Making it real means changing the model
   * and the web app's own form in the same commit, or the web app starts
   * failing validation it never had to satisfy. Until then this stops the
   * extension from being the thing that creates nameless accounts, which is the
   * half that is ours to fix.
   *
   * Checked before the request rather than after, because a round trip is the
   * wrong place to learn about a field that is on screen.
   */
  if (!firstName || !lastName) {
    fail(els["signup-error"], "Please enter both your first and last name.");
    (firstName ? els["signup-last"] : els["signup-first"]).focus();
    return;
  }

  if (!els["signup-terms"].checked) {
    fail(els["signup-error"], "Please accept the terms to create an account.");
    return;
  }

  els.signup.disabled = true;
  els.signup.textContent = "Creating account…";
  try {
    const result = await askWorker({
      type: "ETHYRA_SIGN_UP",
      email: els["signup-email"].value.trim(),
      password: els["signup-password"].value,
      acceptTerms: true,
      firstName,
      lastName,
    });
    if (!result?.ok) throw new Error(result?.error || "Sign-up failed.");
    await showReady({ user: result.user });
  } catch (err) {
    // The backend's own wording, unedited. One of its messages is the only route
    // out of a half-created account — see the note in auth.js.
    fail(els["signup-error"], err.message);
  } finally {
    els.signup.disabled = false;
    els.signup.textContent = "Create account";
  }
});

els["signup-password"].addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.signup.click();
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

/**
 * Abandon a progress view that is never going to finish.
 *
 * This clears the popup's record of the export; it does not reach into the tab
 * and stop one that is genuinely still running. That is the honest scope, and
 * it is why the button says "Stop waiting" rather than "Cancel" — an export
 * mid-upload will still land on the server, and promising otherwise would be a
 * lie the student could check.
 */
els["progress-cancel"].addEventListener("click", async () => {
  stopPolling();
  await askWorker({ type: "ETHYRA_CLEAR_EXPORT" });
  await boot();
});

/**
 * Close the window on a running analysis.
 *
 * Just closes. It does not clear the export state, so reopening the popup comes
 * straight back to this view with the current numbers — which is the point. The
 * analysis is server-side and was never waiting on this window.
 */
els["analysis-close"].addEventListener("click", () => {
  stopPolling();
  window.close();
});

els["analysis-open"].addEventListener("click", async () => {
  fail(els["analysis-error"], "");
  await askWorker({ type: "ETHYRA_OPEN_WEB_APP" });
  // Closed deliberately. A popup left open behind a new tab keeps polling a run
  // the student is now watching in the web app, in better detail.
  window.close();
});

/**
 * Save the archive that was uploaded.
 *
 * Asks the TAB, not the worker: the Blob lives in the page that built it, and
 * moving it through `chrome.runtime.sendMessage` is the same size problem
 * `upload.js` avoids.
 *
 * `askPage` resolving to null means there is no content script in that tab —
 * the student navigated, reloaded, or is looking at a different tab than the one
 * they exported from. That is the common case rather than an edge case, so it
 * gets a sentence saying which, instead of a generic failure.
 */
els["analysis-download"].addEventListener("click", async () => {
  fail(els["analysis-error"], "");
  els["analysis-download"].disabled = true;
  try {
    const result = await askPage({ type: "ETHYRA_DOWNLOAD_ARCHIVE" });
    if (!result) {
      fail(
        els["analysis-error"],
        "The copy is held in the Canvas tab you exported from. Go back to that tab, without reloading it, and try again."
      );
      return;
    }
    if (!result.ok) fail(els["analysis-error"], result.error || "Could not save the copy.");
  } finally {
    els["analysis-download"].disabled = false;
  }
});

els["done-ok"].addEventListener("click", async () => {
  await askWorker({ type: "ETHYRA_CLEAR_EXPORT" });
  await boot();
});

boot();
