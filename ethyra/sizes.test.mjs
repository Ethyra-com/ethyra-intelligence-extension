/**
 * The caps only work on entries that carry a size.
 *
 *   node --test "ethyra/*.test.mjs"
 *
 * `collect.js` enforces two limits and both read `f.size`: a 50 MB per-file cap
 * that drops one file with a warning, and a 500 MB whole-archive cap that
 * refuses the export rather than trimming it.
 *
 * Neither can tell "this file is small" from "nobody recorded a size". A Canvas
 * file entry gets its size from the API; a document generated in the browser has
 * none until something computes it. An entry arriving without one passes both
 * caps, and `buildArchive` then produces the real bytes — after every check that
 * could have acted on them.
 *
 * These test the consumer's actual behaviour. The matching producer assertion
 * lives in `wiring.test.mjs`, because the size is set in `downloader.js` and
 * that file cannot be evaluated here.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// `profile.js` first: `collect.js` reads its constants at call time.
const sandbox = vm.createContext({ console, document: undefined });
for (const file of ["ethyra/profile.js", "ethyra/manifest.js", "helpers.js", "ethyra/collect.js"]) {
  vm.runInContext(readFileSync(join(ROOT, file), "utf8"), sandbox, { filename: file });
}
// `function` declarations land on the context object; top-level `const` does
// not — it goes to the global LEXICAL scope, which scripts share with each other
// but which is invisible from out here. So the caps are read by evaluating their
// names, and destructuring them off `sandbox` would silently yield undefined.
const { oversized, assignmentEntry } = sandbox;
const ETHYRA_MAX_FILE_BYTES = vm.runInContext("ETHYRA_MAX_FILE_BYTES", sandbox);
const ETHYRA_MAX_TOTAL_BYTES = vm.runInContext("ETHYRA_MAX_TOTAL_BYTES", sandbox);

test("the per-file cap drops an oversized file and says so", () => {
  const warnings = [];
  assert.equal(oversized({ filename: "essay.pdf", size: ETHYRA_MAX_FILE_BYTES + 1 }, warnings), true);
  assert.equal(warnings.length, 1, "a dropped file must leave a trace that travels with the upload");
  assert.match(warnings[0], /essay\.pdf/);
});

test("a file exactly at the cap is kept", () => {
  const warnings = [];
  assert.equal(oversized({ filename: "essay.pdf", size: ETHYRA_MAX_FILE_BYTES }, warnings), false);
  assert.deepEqual(warnings, []);
});

test("an entry with no size defeats the per-file cap silently", () => {
  // Not a bug in `oversized` — there is no better answer it could give. It is
  // the reason the producer side is asserted: a generated document that reaches
  // here without a size is indistinguishable from an empty one, and passes.
  const warnings = [];
  assert.equal(oversized({ filename: "submission_text_1.html" }, warnings), false);
  assert.deepEqual(warnings, [], "and it passes without leaving any trace at all");
});

test("the whole-archive total is summed the same way, so a missing size adds nothing", () => {
  // Mirrors `collectExport`'s reduce. A 600 MB submission recorded with no size
  // leaves the total reading zero, and the export proceeds to build and upload
  // an archive the backend answers with 413.
  const total = (files) => files.reduce((sum, f) => sum + (f.size || 0), 0);

  assert.equal(total([{ size: 10 }, { size: 20 }]), 30);
  assert.equal(total([{ size: ETHYRA_MAX_TOTAL_BYTES }, {}]), ETHYRA_MAX_TOTAL_BYTES);
  assert.ok(total([{}, {}, {}]) <= ETHYRA_MAX_TOTAL_BYTES, "three sizeless files weigh nothing");
});

test("the two caps are ordered, and mirror the backend", () => {
  // Per-file below total, or the per-file cap could never fire.
  assert.ok(ETHYRA_MAX_FILE_BYTES < ETHYRA_MAX_TOTAL_BYTES);
  assert.equal(ETHYRA_MAX_FILE_BYTES, 50 * 1024 * 1024);
  assert.equal(ETHYRA_MAX_TOTAL_BYTES, 500 * 1024 * 1024);
});


// ── An oversized submission is not "nothing turned in" ─────────────────────

const FOLDER = "English 10/Essay 1/";
const ASSIGNMENT = { id: 1, name: "Essay 1", points_possible: 100 };
const SUBMISSION = { submitted_at: "2026-09-10T12:00:00Z", score: 88 };

function entryFor(courseFiles) {
  const warnings = [];
  const out = assignmentEntry({
    folder: FOLDER,
    assignment: ASSIGNMENT,
    submission: SUBMISSION,
    courseFiles,
    warnings,
  });
  return { ...out, warnings };
}

test("a submission whose only file is over the cap is left out, not listed as unsubmitted", () => {
  const { entry, withhold, warnings } = entryFor([
    { path: FOLDER, filename: "essay.pdf", role: "submission", size: ETHYRA_MAX_FILE_BYTES + 1 },
    { path: FOLDER, filename: "handout.pdf", role: "instruction_attachment", size: 10 },
  ]);
  assert.equal(entry, null, "files: [] would read as 'No writing to read' for work that exists");
  assert.equal(withhold, true, "the handout is left behind on purpose, not reported as unclaimed");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /essay\.pdf/);
});

test("nothing submitted at all is a gradebook row with no files", () => {
  const { entry, withhold } = entryFor([
    { path: FOLDER, filename: "handout.pdf", role: "instruction_attachment", size: 10 },
  ]);
  // `.length`, not deepEqual: the array is built in the vm context, whose
  // Array.prototype is a different object from this one.
  assert.equal(entry.files.length, 0);
  assert.equal(entry.score, 88);
  assert.equal(withhold, true);
});

test("a submission under the cap is listed with its file", () => {
  const { entry, withhold } = entryFor([{ path: FOLDER, filename: "essay.pdf", role: "submission", size: 10 }]);
  assert.deepEqual(
    entry.files.map((f) => f.path),
    [`${FOLDER}essay.pdf`]
  );
  assert.equal(withhold, false);
});
