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
const scripts = manifest.content_scripts[0].js;

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

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
