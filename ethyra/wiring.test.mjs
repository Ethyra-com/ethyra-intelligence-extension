/**
 * The manifest actually loads what the code calls.
 *
 *   node --test "ethyra/*.test.mjs"
 *
 * Content scripts share one scope and are evaluated in manifest order, so a
 * symbol is available only if some earlier file in that list defines it. Get it
 * wrong and the failure is a `ReferenceError` in a page console nobody is
 * watching, halfway through a student's export.
 *
 * This checks the specific cross-file symbols this fork depends on, by name.
 * A curated list rather than a parser: the mistakes that actually happen are
 * renaming a function, dropping a file from the manifest, or loading two files
 * in the wrong order, and a short explicit list catches all three without
 * inventing a JavaScript scope model.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

/**
 * The injection order, read from the popup.
 *
 * It used to live in `manifest.json`, which declared the bundle on every HTTPS
 * page. The popup now injects it into one tab on demand, so the ordered list
 * moved there and so did this test's source of truth. Parsed out of the source
 * rather than imported: `popup.js` is a browser script that touches `document`
 * at load, and `import`ing it here would run that.
 */
const scripts = (() => {
  const list = read("ethyra/popup.js").match(/const CONTENT_SCRIPTS = \[([\s\S]*?)\];/);
  assert.ok(list, "ethyra/popup.js no longer declares CONTENT_SCRIPTS");
  return [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
})();

/**
 * Source with comments removed.
 *
 * For assertions of the form "this file must not CALL x". These files explain
 * their reasoning at length, and prose that names the very API it is explaining
 * why not to call would otherwise fail the check it exists to document.
 */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Files that must provide each symbol, and the file that consumes it. */
const REQUIRED = [
  // upstream → ours
  ["sanitizeFilename", "helpers.js", "ethyra/collect.js"],
  // The course list is read by the collector, not the content script — there is
  // no picker, so nothing upstream of collection needs to know what exists.
  ["fetchAllCourses", "canvas-api.js", "ethyra/collect.js"],
  ["fetchWithRetry", "canvas-api.js", "ethyra/collect.js"],
  ["isCanvas", "detector.js", "ethyra/content.js"],
  ["downloadCourse", "downloader.js", "ethyra/collect.js"],
  // ours → upstream (the fork's hooks)
  ["ETHYRA_CONTENT_TYPES", "ethyra/profile.js", "downloader.js"],
  ["ROLE_SUBMISSION", "ethyra/manifest.js", "downloader.js"],
  ["ROLE_INSTRUCTION", "ethyra/manifest.js", "downloader.js"],
  // ours → ours
  ["buildManifest", "ethyra/manifest.js", "ethyra/collect.js"],
  ["manifestAssignment", "ethyra/manifest.js", "ethyra/collect.js"],
  ["manifestCourse", "ethyra/manifest.js", "ethyra/collect.js"],
  ["validateManifest", "ethyra/manifest.js", "ethyra/collect.js"],
  ["MANIFEST_NAME", "ethyra/manifest.js", "ethyra/archive.js"],
  ["ETHYRA_MAX_FILE_BYTES", "ethyra/profile.js", "ethyra/collect.js"],
  ["ETHYRA_MAX_TOTAL_BYTES", "ethyra/profile.js", "ethyra/collect.js"],
  ["collectExport", "ethyra/collect.js", "ethyra/content.js"],
  ["buildArchive", "ethyra/archive.js", "ethyra/content.js"],
  ["uploadArchive", "ethyra/upload.js", "ethyra/content.js"],
];

test("every file the manifest lists exists", () => {
  for (const rel of scripts) {
    assert.doesNotThrow(() => read(rel), `manifest lists ${rel}, which is missing`);
  }
});

test("each cross-file symbol is defined, and loaded before its consumer", () => {
  for (const [symbol, provider, consumer] of REQUIRED) {
    assert.ok(scripts.includes(provider), `${provider} is not in the manifest but provides ${symbol}`);
    assert.ok(scripts.includes(consumer), `${consumer} is not in the manifest but uses ${symbol}`);

    const declaration = new RegExp(`^(?:async\\s+)?(?:function|const|let|var)\\s+${symbol}\\b`, "m");
    assert.match(read(provider), declaration, `${provider} does not define ${symbol}`);
    assert.match(read(consumer), new RegExp(`\\b${symbol}\\b`), `${consumer} does not use ${symbol}`);

    assert.ok(
      scripts.indexOf(provider) < scripts.indexOf(consumer),
      `${provider} must load before ${consumer} (it defines ${symbol})`
    );
  }
});

test("nothing is injected until the student opens the popup", () => {
  // Inherited from upstream, the manifest matched every HTTPS host, so Chrome
  // put this whole bundle into every page the student visited. `content.js`
  // guarded itself with `isCanvas()` so nothing RAN — but PRIVACY.md promises
  // the extension "does not run on non-Canvas sites", and a promise kept by a
  // runtime guard inside code that is already loaded is a weaker thing than the
  // sentence claims.
  //
  // Narrowing the pattern to `*.instructure.com` would have traded that for
  // dropping self-hosted Canvas, which `detector.js` supports on purpose and the
  // backend has a `CANVAS_ORIGINS` setting for. So the declaration is gone
  // entirely and `activeTab` does the work — it covers any host, but only the
  // one tab, and only after a click.
  assert.ok(
    !manifest.content_scripts,
    "a content_scripts declaration injects on page load, before any student has asked for anything"
  );
  assert.ok(manifest.permissions.includes("scripting"), "chrome.scripting is how the popup injects");
  assert.ok(manifest.permissions.includes("activeTab"), "activeTab is what scopes the injection to one tab");

  // The alternative to activeTab is a host permission broad enough to inject
  // anywhere, which would put the grant back at install time.
  for (const origin of manifest.host_permissions) {
    assert.ok(!/^\*:\/\/\*\/|^https?:\/\/\*\//.test(origin), `${origin} is an all-hosts permission`);
  }

  const popup = code("ethyra/popup.js");
  assert.match(popup, /chrome\.scripting\.executeScript/);
  // Injection is scoped to a tab id the popup looked up, never to a whole window
  // or to every frame of every tab.
  assert.ok(!/allFrames:\s*true/.test(popup), "the export runs in the top frame only");
});

test("the bundle is injected at most once per tab", () => {
  // These files declare top-level `const`s. A second evaluation in the same
  // isolated world throws `Identifier has already been declared`, killing the
  // listener the first injection registered — so an export would work on the
  // first popup open and be dead on the second.
  const popup = code("ethyra/popup.js");
  assert.match(popup, /LOADED_FLAG/, "the popup must probe before it injects");

  const probe = popup.match(/executeScript\(\{[\s\S]*?func:[\s\S]*?\}\)/);
  assert.ok(probe, "the probe injection moved or was renamed");
  assert.ok(
    popup.indexOf(probe[0]) < popup.indexOf("files: CONTENT_SCRIPTS"),
    "the probe must run before the bundle, or it can never prevent anything"
  );

  // Set outside the `isCanvas()` block: a non-Canvas tab is injected too — it
  // just does nothing — and re-injecting there throws exactly the same way.
  const content = read("ethyra/content.js");
  const flag = content.indexOf("window.__ethyraContentScriptLoaded = true");
  assert.ok(flag !== -1, "content.js must announce that it loaded");
  assert.ok(flag < content.indexOf("if (isCanvas())"), "the flag must be set before the Canvas check");
});

test("ui.js is not loaded, and nothing reachable in Ethyra mode calls it", () => {
  // The popup replaced the in-page panel, so `ui.js` is deliberately absent.
  // `downloader.js` still references three of its functions; every one must sit
  // behind the early return or an `if (ethyra)` guard, or an export dies with a
  // ReferenceError partway through.
  assert.ok(!scripts.includes("ui.js"), "ui.js should not be loaded");

  const source = read("downloader.js");
  for (const fn of ["createDownloadPanel", "updateDownloadPanel"]) {
    // Both live only inside `downloadAsZip`, which Ethyra mode returns before.
    const calls = [...source.matchAll(new RegExp(`\\b${fn}\\(`, "g"))];
    assert.ok(calls.length > 0, `${fn} should still be referenced — upstream's path is intact`);
    const zipStart = source.indexOf("async function downloadAsZip");
    const zipEnd = source.indexOf("\nasync function", zipStart + 1);
    for (const call of calls) {
      assert.ok(
        call.index > zipStart && call.index < zipEnd,
        `${fn}() is called outside downloadAsZip, where Ethyra mode can reach it`
      );
    }
  }
});

test("turndown is not loaded, and Ethyra mode can never ask for it", () => {
  assert.ok(!scripts.includes("turndown.min.js"), "turndown should not be loaded");
  // `htmlToMarkdown` needs TurndownService. The only caller is gated on
  // `isMarkdown`, which is pinned false whenever `ethyra` is set.
  assert.match(
    read("downloader.js"),
    /const isMarkdown = !ethyra && settings\.exportFormat === "markdown"/,
    "isMarkdown must be forced false in Ethyra mode"
  );
});

test("the service worker imports the auth module it uses", () => {
  const sw = manifest.background.service_worker;
  const source = read(sw);
  assert.match(source, /importScripts\("\.\/auth\.js"\)/);
  for (const symbol of ["signIn", "signOut", "getAccessToken", "currentUser"]) {
    assert.match(read("ethyra/auth.js"), new RegExp(`^async function ${symbol}\\b`, "m"));
    assert.match(source, new RegExp(`\\b${symbol}\\(`));
  }
});

test("the popup loads its own script and nothing else", () => {
  const html = read(manifest.action.default_popup);
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["popup.js"]);
});

test("embedded files are labelled by whose body they came from", () => {
  // A file linked from an assignment DESCRIPTION is the teacher's; a file the
  // student embedded in their own rich-text SUBMISSION is theirs. Both must
  // reach `extractLinkedFiles` with a destination, because a call without one
  // queues into `Extracted_Files/` where no assignment claims it — and an
  // unclaimed file never makes it into the archive.
  const source = read("downloader.js");

  const description = source.match(/extractLinkedFiles\(\s*a\.description[^;]*?\)/s);
  assert.ok(description, "the assignment-description call site moved or was renamed");
  assert.match(description[0], /\bdest\b/, "the description call must pass a destination");

  const submission = source.match(/extractLinkedFiles\(\s*h\.body[^;]*?\)/s);
  assert.ok(submission, "the submission-body call site moved or was renamed");
  assert.match(submission[0], /ROLE_SUBMISSION/, "a file the student embedded is the student's");
  assert.match(submission[0], /folder/, "it belongs in the assignment's own folder");

  // The default stays the teacher's, since the description call is the one that
  // omits a role.
  assert.match(source, /role: dest\.role \|\| ROLE_INSTRUCTION/);
});

test("Ethyra mode queues nothing at the archive root", () => {
  // Upstream writes several files at the root of a course folder — a stylesheet,
  // a manifest, gradebook CSVs, a broken-links report. All are for a person
  // opening the folder. This fork uploads the archive instead, and `collect.js`
  // ships only what an assignment claimed, so a root-level entry cannot be
  // claimed by anything and is dropped.
  //
  // `styles.css` was queued in Ethyra mode for exactly as long as this fork has
  // existed, because `isMarkdown` is pinned false and the guard read
  // `if (!isMarkdown)`. Every course of every export therefore produced an
  // unclaimed-file warning — and that warning was added to surface files being
  // lost in silence. One that fires on every successful export is one nobody
  // reads, which would have returned the bug it was written for to invisibility.
  //
  // So this checks the class, not the line: every root-level push must be
  // unreachable in Ethyra mode, whether by an explicit guard or by a content
  // type `ethyra/profile.js` turns off.
  const source = read("downloader.js");
  const lines = source.split("\n");

  const disabled = new Set(
    [...read("ethyra/profile.js").matchAll(/^\s*(\w+):\s*false\b/gm)].map((m) => m[1])
  );
  assert.ok(disabled.size > 0, "ETHYRA_CONTENT_TYPES no longer switches anything off");

  const roots = [];
  lines.forEach((line, i) => {
    if (!/^\s*path: "",?$/.test(line)) return;
    // Only queued entries matter. Upstream's `START_DOWNLOAD` message payload
    // uses the same shape and never reaches the archive.
    const open = lines.slice(Math.max(0, i - 12), i).join("\n");
    if (!open.includes("filesToDownload.push({")) return;
    roots.push({ line: i + 1, context: lines.slice(Math.max(0, i - 40), i).join("\n") });
  });

  assert.ok(roots.length >= 4, `expected upstream's root-level writers to still be present, found ${roots.length}`);

  for (const { line, context } of roots) {
    const guarded =
      /!ethyra\b/.test(context) ||
      /if \(ethyra\)[\s\S]*\} else \{/.test(context) ||
      [...disabled].some((type) => new RegExp(`types\\.${type}\\b`).test(context));
    assert.ok(guarded, `downloader.js:${line} queues a root-level file reachable in Ethyra mode`);
  }
});

test("no message reachable in Ethyra mode names a file this archive does not contain", () => {
  // The inaccessible-links branch swapped upstream's root-level CSV for a
  // warning on the upload, and left the progress line still saying the failures
  // were "listed in _inaccessible_links.csv" — a file the Ethyra archive does
  // not contain and the student has no folder to look in for.
  //
  // Same shape as the 413 message that told students to deselect a course: the
  // behaviour changed, the sentence describing it did not. The previous test
  // pins where files are QUEUED; this one pins what is SAID about them, because
  // fixing one has twice now left the other stale.
  const source = read("downloader.js");
  const lines = source.split("\n");

  // Whatever upstream writes at a course root, derived rather than listed — a
  // new root-level CSV is then covered the day it is added.
  const rootFiles = [];
  lines.forEach((line, i) => {
    if (!/^\s*path: "",?$/.test(line)) return;
    const block = lines.slice(Math.max(0, i - 12), i).join("\n");
    if (!block.includes("filesToDownload.push({")) return;
    const name = block.match(/filename: "([^"]+)"/);
    if (name) rootFiles.push(name[1]);
  });
  assert.ok(rootFiles.length >= 4, `expected upstream's root-level files, found ${rootFiles.join(", ")}`);

  // Comments discuss these files at length, and should keep being able to.
  code("downloader.js")
    .split("\n")
    .forEach((line, i) => {
      for (const file of rootFiles) {
        if (!line.includes(file)) continue;
        // The queue site itself is the declaration, not a claim about the archive.
        if (new RegExp(`filename: "${file.replace(".", "\\.")}"`).test(line)) continue;
        assert.match(
          line,
          /ethyra/,
          `downloader.js:${i + 1} names ${file} in text Ethyra mode can reach:\n    ${line.trim()}`
        );
      }
    });
});

test("files no assignment claims are reported, not silently dropped", () => {
  // `collectExport` uploads only what an assignment claimed. Dropping the rest
  // in silence is what hid the bug above for an entire build.
  const source = read("ethyra/collect.js");
  assert.match(source, /unclaimed/);
  assert.match(source, /warnings\.push\(/);
});

test("the CDN host permission is required, never requested at runtime", () => {
  // Submitted files are served from canvas-user-content.com, so reaching it is
  // not optional for an extension whose whole job is uploading them.
  //
  // It also could not be obtained at runtime. MV3 requires
  // `chrome.permissions.request()` to run inside an active user gesture, which
  // survives one synchronous message hop from a UI context — and this check
  // arrives from a content script several async hops into an export. Requesting
  // there could not succeed, and the failure was invisible: the fetches failed
  // individually, `pruneFailed` rewrote the manifest to match, and the backend
  // received a smaller, internally consistent, wrong picture of the student.
  const CDN = "*://*.canvas-user-content.com/*";
  assert.ok(manifest.host_permissions.includes(CDN), "the CDN origin must be a required host permission");
  assert.ok(
    !(manifest.optional_host_permissions || []).includes(CDN),
    "optional means requestable, and it cannot be requested from where this runs"
  );

  const worker = code(manifest.background.service_worker);
  assert.match(worker, /permissions\.contains\(/, "the worker should CHECK the permission");
  assert.ok(
    !/permissions\.request\(/.test(worker),
    "the worker must not request a permission it has no gesture to request with"
  );

  // A missing required permission is a broken install, so the export stops
  // rather than uploading whichever files happened to survive.
  const source = read("downloader.js");
  const block = source.slice(source.indexOf("ENSURE_CDN_PERMISSION"));
  assert.match(block.slice(0, 1200), /if \(ethyra\) \{\s*throw new Error\(/);
});

test("no student-facing message tells them to use a control that does not exist", () => {
  // The 413 message told students to deselect a course — wording left over from
  // a popup that briefly had a course picker. This export has none: every active
  // enrolment goes, every time.
  //
  // A message suggesting something impossible is worse than a bare status code.
  // It sends someone looking for a control that is not there and leaves them
  // thinking they did it wrong.
  const CONTROLS_THAT_DO_NOT_EXIST = [
    /deselect/i,
    /unselect/i,
    /choose which course/i,
    /select fewer/i,
    /uncheck/i,
    // Nothing is saved to disk, so there is no file to find, open or re-upload.
    /your downloads folder/i,
    /the downloaded (file|zip)/i,
  ];

  // Comments stripped: these files explain at length why the wording changed,
  // and prose describing the mistake must not fail the check that documents it.
  for (const file of ["ethyra/collect.js", "ethyra/upload.js", "ethyra/content.js", "ethyra/popup.js"]) {
    const source = code(file);
    for (const pattern of CONTROLS_THAT_DO_NOT_EXIST) {
      assert.ok(!pattern.test(source), `${file} mentions ${pattern}, which this extension has no control for`);
    }
  }

  // And the popup markup, which is where the copy a student reads first lives.
  const popup = read(manifest.action.default_popup).replace(/<!--[\s\S]*?-->/g, "");
  for (const pattern of CONTROLS_THAT_DO_NOT_EXIST) {
    assert.ok(!pattern.test(popup), `the popup mentions ${pattern}`);
  }
});

test("a release build carries no unanswered privacy placeholders", (t) => {
  // PRIVACY.md holds `[TODO]`s for facts that are legal and business decisions —
  // the retention period, the legal entity, the FERPA role, the contact address.
  // They cannot be written from the code and must not be invented; a fabricated
  // retention period is a checkable false statement, which is worse than a
  // visibly unfinished one.
  //
  // But "resolve before release" written inside the document it governs is not a
  // gate, it is a hope. A privacy policy is a hard Chrome Web Store requirement
  // and the pressure at submission time is to ship.
  //
  // So the gate is the version. The store requires a bump on every submission,
  // which makes it the one thing that cannot be forgotten on the way out, and
  // leaving 0.x is the deliberate act of calling this releasable.
  const privacy = readFileSync(join(ROOT, "PRIVACY.md"), "utf8");
  const placeholders = privacy.match(/\[TODO/g) || [];

  if (manifest.version.startsWith("0.")) {
    t.diagnostic(`${placeholders.length} privacy placeholder(s) outstanding — blocking at version 1.0.0`);
    return;
  }

  assert.equal(
    placeholders.length,
    0,
    `PRIVACY.md still has ${placeholders.length} [TODO] placeholder(s) at version ${manifest.version}`
  );
});

test("the disclosures do not claim to collect what the code refuses to ask for", () => {
  // NOTICE said this extension transmits "grades and instructor comments" — true
  // of the plan it was written from, and false of the code for as long as the
  // code has existed. It contradicted PRIVACY.md, which a student reads, and it
  // overstated collection in the one document a reviewer reaches for first.
  //
  // Only the AFFIRMATIVE half of each disclosure is checked. Both documents name
  // grades and comments at length in order to say they are excluded, and a test
  // that could not tell "we collect X" from "we do not collect X" would force
  // the documents to stop being clear in order to stay green.
  const NEVER_COLLECTED = [/\bgrades?\b/i, /instructor comments/i, /rubric marks/i, /class (averages|statistics)/i];

  const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
  const start = notice.indexOf("What is read:");
  const end = notice.indexOf("What is not read");
  assert.ok(start !== -1 && end > start, "NOTICE's student-data section moved or was restructured");
  for (const pattern of NEVER_COLLECTED) {
    assert.ok(!pattern.test(notice.slice(start, end)), `NOTICE lists ${pattern} as collected`);
  }

  // PRIVACY.md's equivalent: everything above its "What it does not read" heading.
  const privacy = readFileSync(join(ROOT, "PRIVACY.md"), "utf8");
  const cut = privacy.indexOf("## What it does not read");
  assert.ok(cut !== -1, "PRIVACY.md's exclusion heading moved or was renamed");
  for (const pattern of NEVER_COLLECTED) {
    assert.ok(!pattern.test(privacy.slice(0, cut)), `PRIVACY.md lists ${pattern} as collected`);
  }
});

test("nothing asks Canvas for marks", () => {
  // The cheapest place to enforce "we do not collect grades" is the request:
  // data not asked for is data not received, and no later filter can be
  // forgotten. `submission_comments`, `rubric_assessment` and `score_statistics`
  // must appear only on upstream's branch of each ternary.
  const source = read("downloader.js");
  for (const include of ["score_statistics", "submission_comments", "rubric_assessment"]) {
    const lines = source.split("\n").filter((l) => l.includes(`include[]=${include}`));
    for (const line of lines) {
      assert.ok(
        !line.includes("ethyra ?") || line.trim().startsWith(": "),
        `${include} must not be requested on the Ethyra branch: ${line.trim()}`
      );
    }
  }
  // And the manifest builder has no field for any of them.
  const builder = read("ethyra/manifest.js");
  for (const field of ["score:", "grade:", "points_possible:", "score_statistics:", "teacher_comments:"]) {
    assert.ok(!builder.includes(field), `manifest.js still emits ${field}`);
  }
});
