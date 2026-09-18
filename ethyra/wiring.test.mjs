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
 * Source with comment CONTENT removed and its line numbering intact.
 *
 * For assertions of the form "this file must not do x". These files explain
 * their reasoning at length, and prose naming the very thing it is explaining
 * why not to do would otherwise satisfy — or fail — the check it documents.
 *
 * Two details that were both wrong here before:
 *
 * Block comments are blanked rather than deleted, so a line number in an
 * assertion message still points at the line a reader will find.
 *
 * And the leading-whitespace class is `[^\S\n]`, not `\s`. Under `m`, `\s`
 * matches a newline, so anchoring a line-comment pattern with `\s` swallowed
 * every blank line preceding a comment — 61 lines of `downloader.js`, silently.
 * That is what made the offsets in these tests unusable, and hid a guard check
 * that was passing on prose.
 */
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^[^\S\n]*\/\/.*$/gm, "");

/** Indentation width, for walking out of a block to the guards enclosing it. */
const indentOf = (line) => line.match(/^[ \t]*/)[0].length;

/**
 * The conditions enclosing `index`, outermost last.
 *
 * A 40-line window was the previous approximation and it was not sound: it
 * accepted an `!ethyra` appearing anywhere nearby, including in a comment
 * explaining a different guard. `manifest.json` passed on exactly that and
 * failed the moment comments were stripped.
 *
 * An `} else {` is returned together with the `if` it belongs to, prefixed
 * `else-of:`, because "the branch Ethyra mode does not take" is a guard.
 */
function guardsAround(lines, index) {
  const found = [];
  let depth = indentOf(lines[index]);
  for (let j = index - 1; j >= 0 && depth > 0; j--) {
    const line = lines[j];
    if (!line.trim() || !line.trimEnd().endsWith("{")) continue;
    const ind = indentOf(line);
    if (ind >= depth) continue;
    depth = ind;
    found.push(line);
    if (/^\s*\}\s*else\s*\{/.test(line)) {
      for (let k = j - 1; k >= 0; k--) {
        // A blank line is not a dedent. `indentOf("")` is 0, so without this the
        // scan stops at the first empty line inside the `if` branch and never
        // reaches the `if` that owns this `else` — reporting a correctly guarded
        // site as unguarded. `code()` blanks every comment line to "", so one
        // comment in that branch was enough to trigger it.
        if (!lines[k].trim()) continue;
        if (indentOf(lines[k]) < ind) break;
        if (indentOf(lines[k]) === ind && /^\s*(\}\s*else\s+)?if \(/.test(lines[k])) {
          found.push(`else-of:${lines[k]}`);
          break;
        }
      }
    }
  }
  return found;
}

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

test("guardsAround reports the conditions that enclose a line, and only those", () => {
  // This helper decides whether two of the tests below pass. It had no coverage
  // of its own, which is how the thing it replaced — a 40-line proximity window —
  // went on quietly accepting a comment as a guard.
  const at = (...src) => {
    const lines = src.join("\n").split("\n");
    return [lines, lines.findIndex((l) => l.includes("TARGET"))];
  };
  const guards = (...src) => guardsAround(...at(...src));

  // A blank line is not a dedent. `code()` blanks every comment to "", so a
  // single comment inside the taken branch used to hide the `if` owning the
  // `else` — reporting a correctly guarded site as unguarded.
  const acrossBlank = guards(
    "  if (ethyra) {",
    "    warn();",
    "",
    "    more();",
    "  } else {",
    "    TARGET",
    "  }"
  );
  assert.ok(
    acrossBlank.some((g) => g.startsWith("else-of:") && /if \(ethyra\)/.test(g)),
    `the else branch of an if (ethyra) is a guard: ${acrossBlank.join(" | ")}`
  );

  // Scope, not proximity: a sibling block that happens to sit nearby guards
  // nothing. This is the property the proximity window did not have.
  const sibling = guards(
    "  if (!ethyra) {",
    "    unrelated();",
    "  }",
    "  if (types.grades) {",
    "    TARGET",
    "  }"
  );
  assert.ok(!sibling.some((g) => /!ethyra/.test(g)), `a sibling block is not a guard: ${sibling.join(" | ")}`);
  assert.ok(sibling.some((g) => /types\.grades/.test(g)), sibling.join(" | "));

  // Nesting reports every enclosing level, so an outer guard still counts and an
  // inner block does not need its own.
  const nested = guards("  if (!ethyra) {", "    for (const f of files) {", "      TARGET", "    }", "  }");
  assert.ok(nested.some((g) => /!ethyra/.test(g)), nested.join(" | "));

  // An unguarded site reports nothing rather than reaching for whatever precedes it.
  const bare = guards("  if (ethyra) {", "    warn();", "  }", "  TARGET");
  assert.equal(bare.length, 0, `nothing encloses it: ${bare.join(" | ")}`);
});

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
  // Comments stripped: this file argues about Ethyra mode at length, and a
  // guard check satisfied by prose is not a guard check. `manifest.json` was
  // passing on a comment, which is the failure this rewrite exists for.
  const lines = code("downloader.js").split("\n");

  const disabled = new Set(
    [...code("ethyra/profile.js").matchAll(/^\s*(\w+):\s*false\b/gm)].map((m) => m[1])
  );
  assert.ok(disabled.size > 0, "ETHYRA_CONTENT_TYPES no longer switches anything off");

  const roots = [];
  lines.forEach((line, i) => {
    if (!/^\s*path: "",?$/.test(line)) return;
    // Only queued entries matter. Upstream's `START_DOWNLOAD` message payload
    // uses the same shape and never reaches the archive.
    const open = lines.slice(Math.max(0, i - 12), i).join("\n");
    if (!open.includes("filesToDownload.push({")) return;
    const name = (lines.slice(Math.max(0, i - 12), i).find((l) => l.includes("filename:")) || "").trim();
    roots.push({ line: i + 1, name, guards: guardsAround(lines, i) });
  });

  assert.ok(roots.length >= 4, `expected upstream's root-level writers to still be present, found ${roots.length}`);

  for (const { line, name, guards } of roots) {
    // Scope, and polarity. Each has to be a condition that EXCLUDES Ethyra mode:
    // a negative guard, the else of an `if (ethyra)`, or a content type the
    // profile turns off.
    const excluded = guards.some(
      (g) =>
        /!ethyra\b/.test(g) ||
        (g.startsWith("else-of:") && /\bif \(ethyra\)/.test(g)) ||
        [...disabled].some((type) => new RegExp(`types\\.${type}\\b`).test(g))
    );
    assert.ok(
      excluded,
      `downloader.js:${line} queues a root-level file reachable in Ethyra mode (${name})\n` +
        `    enclosing guards: ${guards.length ? guards.map((g) => g.trim()).join(" | ") : "none"}`
    );
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

        // Merely mentioning `ethyra` on the line is not enough — that accepts
        // `ethyra ? " — listed in …" : ""`, which names the file in precisely
        // the branch Ethyra mode takes. So read the ternary and check the side
        // Ethyra mode actually selects.
        const ternary = line.match(/(!?)\s*ethyra\s*\?([^:]*):(.*)$/);
        assert.ok(
          ternary,
          `downloader.js:${i + 1} names ${file} outside an explicit ethyra ternary:\n    ${line.trim()}`
        );
        const [, negated, whenTrue, whenFalse] = ternary;
        const ethyraBranch = negated ? whenFalse : whenTrue;
        assert.ok(
          !ethyraBranch.includes(file),
          `downloader.js:${i + 1} names ${file} in the branch Ethyra mode takes:\n    ${line.trim()}`
        );
      }
    });
});

test("HTML the student wrote is link-rewritten, and nothing is added to it", () => {
  // Two requirements that pull against each other, which is why this is one test.
  //
  // REWRITTEN: a file the student embedded in their own prose is harvested into
  // the same folder, and `urlMap` maps its Canvas URL to that local copy — but
  // only entries carrying `rawBody` reach the rewrite pass that consults it.
  // Building a finished data-URI at push time skips it, so the archive held the
  // image while the HTML still pointed at Canvas: a verifier-bound, expiring URL
  // persisted into Ethyra's storage, and a local copy nothing referenced.
  //
  // UNCHANGED: the obvious fix is upstream's `buildDocEntry`, which ends in
  // `toHtmlDataUri` and puts `<h1>${title}</h1>` at the top of the document.
  // This file exists so the backend quotes from something the student wrote.
  // A heading naming the attempt is text they did not write, inserted into the
  // document the proficiency stage quotes character-for-character and segments
  // into the `<p n="N">` markers the whole evidence contract rests on.
  const source = read("downloader.js");

  // Bounded rather than `[^}]*`: the block interpolates `${h.attempt || 1}`, so
  // a brace-free match stops short of the fields being asserted on.
  const push = source.match(/filesToDownload\.push\(\{[\s\S]{0,500}?submission_text_[\s\S]{0,300}?\}\);/);
  assert.ok(push, "the inline-submission push moved or was renamed");
  assert.match(push[0], /rawBody:/, "it must carry rawBody, or the rewrite pass never sees it");
  assert.match(push[0], /bareHtml:/, "it must opt out of the document wrapper");
  assert.match(push[0], /role: ROLE_SUBMISSION/);

  // The general form: any finished HTML data-URI built at push time has bypassed
  // the rewrite. The pass itself is the one legitimate place to build one.
  const rewriteStart = source.indexOf("--- Rewrite + encode pass");
  assert.ok(rewriteStart !== -1, "the rewrite pass moved or was renamed");
  for (const m of source.matchAll(/data:text\/html/g)) {
    assert.ok(
      m.index > rewriteStart,
      `downloader.js builds an HTML data-URI at offset ${m.index}, before the rewrite pass that repoints its links`
    );
  }

  // The pass itself, bounded by its own last statement rather than a character
  // count: a fixed window silently shrinks every time someone explains one of
  // these branches, and then stops covering the line it was written to check.
  const passEnd = source.indexOf("delete f.resourceId", rewriteStart);
  assert.ok(passEnd > rewriteStart, "the rewrite loop's tail moved or was renamed");
  const pass = source.slice(rewriteStart, passEnd);

  // MEASURED: both of Ethyra's caps read `f.size`, and a document generated in
  // the browser has none unless something computes it. This is the only
  // generated document Ethyra mode emits, so it was the only entry reaching
  // `collect.js` sizeless — where a missing size reads as zero and passes the
  // 50 MB per-file cap and contributes nothing to the 500 MB total. See
  // `sizes.test.mjs` for what the consumer actually does with that.
  //
  // It has to measure the SAME string that becomes the archive entry. Measuring
  // `rewritten` would count pre-sanitised bytes; measuring the data-URI would
  // count percent-encoding that is never stored. So the identifier is captured
  // from the URI construction and required again in the size assignment.
  const encoded = pass.match(/encodeURIComponent\((\w+)\)/);
  assert.ok(encoded, "the bare data-URI construction moved or was renamed");
  const body = encoded[1];
  assert.match(
    pass,
    new RegExp(`f\\.size = new TextEncoder\\(\\)\\.encode\\(${body}\\)\\.byteLength`),
    `the bare branch must record the byte length of ${body}, the string it stores`
  );

  // And the bare branch must not route through the wrapper.
  assert.match(pass, /f\.bareHtml\s*\n?\s*\?/, "the pass must branch on bareHtml");
  const bare = pass.match(/f\.bareHtml[\s\S]*?:\s*isMarkdown/);
  assert.ok(bare && !/toHtmlDataUri/.test(bare[0]), "the bare branch must not wrap the student's document");
});

test("a course the user teaches is rejected before anything is fetched from it", () => {
  // `fetchCourseRole` is true for teacher, TA and designer, and every teacher
  // branch below it reads other people's work. Worse, `renderSubmission` is
  // shared between the teacher and student paths and records into the Ethyra
  // recorder regardless of which one called it.
  //
  // Nothing reached the archive before this guard, but only by accident: the
  // teacher path files land under `Submissions/<assignment>/<student>/` and
  // `collect.js` claims only files in the assignment's own folder, so they were
  // dropped. A refactor aligning those two folder schemes — the kind that looks
  // like tidying — would have started uploading other students' work under a
  // teacher's account with nothing failing.
  //
  // Position is the whole point. A filter after collection still pulls every
  // student's submissions, comment threads and rubric marks into the tab, which
  // has happened whether or not anything is uploaded afterwards, and which
  // PRIVACY.md tells students does not happen. So this asserts ORDER, not
  // presence.
  const source = read("downloader.js");

  const roleAt = source.indexOf("const isTeacher = await fetchCourseRole");
  assert.ok(roleAt !== -1, "the role resolution moved or was renamed");

  const guard = source.slice(roleAt).match(/if \(ethyra && isTeacher\) \{[\s\S]{0,600}?\}/);
  assert.ok(guard, "Ethyra mode must reject a teaching role at the point it is resolved");
  assert.match(guard[0], /throw /, "it must abort the course, not merely warn");
  assert.match(guard[0], /ETHYRA_NOT_A_STUDENT/, "carry a code, so a skip is distinguishable from a failure");

  const guardEnd = roleAt + guard.index + guard[0].length;

  // Nothing may be fetched between the role resolving and the guard. Measured
  // from the end of that statement, since resolving the role is itself an await.
  const between = source.slice(source.indexOf("\n", roleAt), roleAt + guard.index);
  assert.ok(!/await |fetchAllPages\(|fetchWithRetry\(/.test(between), "a fetch slipped in before the guard");

  // Every teacher-only fetch must sit after it.
  for (const m of source.matchAll(/if \(isTeacher/g)) {
    assert.ok(m.index > guardEnd, `a teacher branch at offset ${m.index} precedes the guard`);
  }
  // The one endpoint that returns other students' submissions, specifically.
  const roster = source.indexOf("assignments/${a.id}/submissions?per_page=100");
  assert.ok(roster > guardEnd, "the all-students submissions fetch must be unreachable in Ethyra mode");

  // And the skip must read as a skip.
  const collect = read("ethyra/collect.js");
  assert.match(collect, /ETHYRA_NOT_A_STUDENT/, "collect.js must recognise the code");
  const branch = collect.match(/ETHYRA_NOT_A_STUDENT\)[\s\S]{0,400}?continue;/);
  assert.ok(branch, "the skip branch moved or was renamed");
  assert.ok(
    !/could not be collected/.test(branch[0]),
    "a deliberate skip must not be reported as a failure — that is what makes someone retry"
  );
});

test("no upstream setting can quietly shrink an Ethyra export", () => {
  // `settings` comes from `chrome.storage.sync` with upstream's defaults. This
  // fork has no options page and a popup with no settings, so in practice they
  // are always the defaults — which is why none of these had visibly misfired.
  //
  // "Unreachable" is a property of the current UI, not of the code. Upstream's
  // options page is still in the tree, `git merge upstream/main` is a supported
  // operation here, and `chrome.storage.sync` is writable from a console. Each
  // of these settings drops student work and says so only in a log line:
  //
  //   incrementalMode   omits unchanged files — and the backend dedupes by
  //                     content hash already, so a file missing from the archive
  //                     is not "unchanged" to it, it is a file the student no
  //                     longer has. The profile rewinds.
  //   maxFileSizeMB     drops a submission over an arbitrary size
  //   excludeVideos     drops a media-recording submission, which is work
  //
  // Each would produce a smaller archive with a manifest that agrees with it.
  const source = read("downloader.js");
  const ethyraReturn = source.indexOf("if (ethyra) return filesToDownload");
  assert.ok(ethyraReturn !== -1, "the Ethyra hand-back moved or was renamed");

  const lines = source.slice(0, ethyraReturn).split("\n");
  const indent = (s) => s.match(/^\s*/)[0].length;

  lines.forEach((line, i) => {
    if (!/^\s*if \(.*\bsettings\./.test(line)) return;
    if (/!ethyra/.test(line)) return;

    // A nested read is fine when some enclosing block already excluded Ethyra
    // mode — guarding both would be noise, and noise is what stops being read.
    // Walk out through the ancestors by indentation.
    let depth = indent(line);
    for (let j = i - 1; j >= 0 && depth > 0; j--) {
      if (!lines[j].trim() || !lines[j].trimEnd().endsWith("{")) continue;
      if (indent(lines[j]) >= depth) continue;
      depth = indent(lines[j]);
      if (/!ethyra/.test(lines[j])) return;
    }

    assert.fail(`downloader.js:${i + 1} branches on a setting Ethyra mode can reach:\n    ${line.trim()}`);
  });

  // The inventory write is the one that was actually running: it sits outside
  // the `incrementalMode` check, so every export recorded files it never
  // downloaded locally.
  const write = source.indexOf("chrome.storage.local.set({ [incrementalKey]");
  assert.ok(write !== -1, "the incremental inventory write moved or was renamed");
  assert.ok(
    /if \(!ethyra\) \{/.test(source.slice(Math.max(0, write - 700), write)),
    "the incremental inventory write must be skipped in Ethyra mode"
  );
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
