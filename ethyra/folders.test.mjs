/**
 * Folder names are identities, so they have to be unique.
 *
 *   node --test "ethyra/*.test.mjs"
 *
 * A folder keys the recorder's map of assignments AND is what `collectExport`
 * matches files against, so two assignments sharing one folder become one
 * assignment holding both their files — measured against whichever handout was
 * recorded last.
 *
 * The failure is quiet in the worst way: the manifest that results passes
 * `validateManifest` cleanly. Every file exists, every file is claimed, there is
 * submitted work. Nothing downstream can tell it from a correct export.
 *
 * ── Why a sandbox ─────────────────────────────────────────────────────
 *
 * `collect.js` is a content script: no exports, and it reads `sanitizeFilename`
 * from `helpers.js` as a shared global. Both files are side-effect-free at the
 * top level, so evaluating them together in a `vm` context gives the real
 * functions rather than a copy of their logic — which is the whole point, since
 * a reimplementation here would pass while the shipped code collided.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const sandbox = vm.createContext({ console, document: undefined });
for (const file of ["helpers.js", "ethyra/collect.js"]) {
  vm.runInContext(readFileSync(join(ROOT, file), "utf8"), sandbox, { filename: file });
}
const { courseFolderFor, assignmentFolderFor } = sandbox;

const COURSE = { id: 4567, name: "AP World History" };
const folderFor = (assignment, course = COURSE) =>
  assignmentFolderFor(courseFolderFor(course), assignment);

test("two assignments with the same name get different folders", () => {
  const a = folderFor({ id: 1, name: "Weekly Reflection" });
  const b = folderFor({ id: 2, name: "Weekly Reflection" });
  assert.notEqual(a, b);
});

test("two long names sharing their first 80 characters get different folders", () => {
  // The likeliest collision of the three: long assignment titles are common and
  // the distinguishing word tends to sit at the end.
  const stem = "Research Paper on the Political and Economic Consequences of Decolonisation in ";
  const a = folderFor({ id: 3, name: `${stem}Africa` });
  const b = folderFor({ id: 4, name: `${stem}Asia` });
  assert.notEqual(a, b);
});

test("two names that sanitise to the same string get different folders", () => {
  const a = folderFor({ id: 5, name: "Essay: Part 1" });
  const b = folderFor({ id: 6, name: "Essay- Part 1" });
  assert.notEqual(a, b);
});

test("two courses with the same name get different folders", () => {
  const a = courseFolderFor({ id: 10, name: "Biology" });
  const b = courseFolderFor({ id: 11, name: "Biology" });
  assert.notEqual(a, b);
});

test("the id survives truncation", () => {
  // Appended AFTER the cut, or the thing making the name unique is the first
  // thing lost.
  const folder = folderFor({ id: 891011, name: "x".repeat(400) });
  assert.match(folder, /-891011\/$/);
});

test("a course folder stays exactly one path component", () => {
  // The backend rejects a course path with a separator in it.
  const folder = courseFolderFor({ id: 4567, name: "History / Geography" });
  assert.ok(!folder.includes("/"), folder);
});

test("an assignment folder sits directly inside its course", () => {
  const course = courseFolderFor(COURSE);
  const folder = folderFor({ id: 99, name: "Essay 3" });
  assert.ok(folder.startsWith(`${course}/`));
  assert.equal(folder.slice(course.length + 1).split("/").filter(Boolean).length, 1);
});

test("a missing id degrades to a label rather than an empty suffix", () => {
  // Canvas always sends one; an empty suffix would silently restore the
  // collision this whole scheme exists to prevent.
  assert.match(courseFolderFor({ id: undefined, name: "Biology" }), /-unknown$/);
});

test("Canvas string ids work as well as numeric ones", () => {
  // The extension sends `Accept: application/json+canvas-string-ids`.
  assert.equal(courseFolderFor({ id: "4567", name: "Biology" }), courseFolderFor({ id: 4567, name: "Biology" }));
});
