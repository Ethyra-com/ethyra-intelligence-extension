/**
 * Courses are read side by side, and nothing about the export depends on which
 * one finished first.
 *
 *   node --test "ethyra/*.test.mjs"
 *
 * `collect.js` runs against a fake Canvas: `downloadCourse` records one
 * submitted essay per course and takes a set time to do it, so the tests can
 * make courses finish in any order they like and count how many ran at once.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = { log() {}, info() {}, warn() {}, error() {}, table() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `collect.js` with a fake Canvas holding `names`, one course each.
 * `delayFor(name)` is how long that course takes to read.
 */
function loadCollect(names, { delayFor = () => 5 } = {}) {
  const stats = { inFlight: 0, maxInFlight: 0, started: [] };
  const courses = names.map((name, i) => ({ id: String(100 + i), name, course_code: name, term: { name: "2021-22" } }));

  const sandbox = vm.createContext({
    console: quiet,
    document: undefined,
    setTimeout,
    URL,
    fetchWithRetry: async () => ({ ok: true, json: async () => ({ id: "7", name: "Student" }) }),
    fetchAllCourses: async (state) => (state === "active" ? courses : []),
    downloadCourse: async (courseId, name, origin, log, recorder) => {
      stats.started.push(name);
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        const assignment = { id: `${courseId}1`, name: "Essay" };
        recorder.recordAssignment(assignment);
        recorder.recordSubmission(assignment, { workflow_state: "submitted" });
        await sleep(delayFor(name));
        return [{ path: recorder.assignmentFolder(assignment), filename: "essay.txt", size: 10, url: "x" }];
      } finally {
        stats.inFlight--;
      }
    },
  });
  for (const f of ["ethyra/profile.js", "ethyra/manifest.js", "helpers.js", "ethyra/collect.js"]) {
    vm.runInContext(readFileSync(join(ROOT, f), "utf8"), sandbox, { filename: f });
  }
  return { sandbox, stats };
}

const NAMES = ["Algebra", "Biology", "Chemistry", "Drawing", "English", "French", "Geometry"];

test("courses are read side by side, never more than three at once", async () => {
  const { sandbox, stats } = loadCollect(NAMES);
  const { manifest } = await sandbox.collectExport({ origin: "https://school.test", extensionVersion: "0" });
  assert.equal(stats.maxInFlight, 3);
  assert.equal(manifest.courses.length, NAMES.length);
});

test("the export comes out in course order, whichever course finished first", async () => {
  // The first course is the slowest, so it finishes last.
  const { sandbox } = loadCollect(NAMES, { delayFor: (name) => (name === "Algebra" ? 40 : 2) });
  const { manifest, files } = await sandbox.collectExport({ origin: "https://school.test", extensionVersion: "0" });
  // Spread into this realm's Array: the sandbox's arrays are not deepEqual to ours.
  assert.deepEqual([...manifest.courses.map((c) => c.name)], NAMES);
  assert.ok(files[0].path.startsWith("Algebra-"), "files are assembled in course order too");
});

test("a failure that ends the export stops new courses from starting", async () => {
  const { sandbox, stats } = loadCollect(NAMES);
  const sendCourse = async ({ course }) => {
    if (course === "Biology") throw new Error("over the limit");
    return { failed: [], hashes: new Map() };
  };
  await assert.rejects(
    sandbox.collectExport({ origin: "https://school.test", extensionVersion: "0", sendCourse }),
    /over the limit/
  );
  assert.ok(stats.started.length < NAMES.length, `started ${stats.started.length} of ${NAMES.length}`);
});

// ── Canvas's throttle ────────────────────────────────────────────────────

function loadCanvasApi(answers) {
  const seen = [];
  const sandbox = vm.createContext({
    console: quiet,
    AbortController,
    TextDecoder,
    // Every wait at a hundredth of its length: retries back off in 10-80 ms and
    // the throttling check gives up on a body after 50 ms.
    setTimeout: (fn, ms = 0) => setTimeout(fn, ms / 100),
    clearTimeout,
    fetch: async (url) => {
      seen.push(url);
      const { status = 200, body = "" } = answers.shift() || {};
      return new Response(body, { status });
    },
  });
  vm.runInContext(readFileSync(join(ROOT, "canvas-api.js"), "utf8"), sandbox, { filename: "canvas-api.js" });
  return { sandbox, seen };
}

test("Canvas's rate-limit 403 is waited out and retried", async () => {
  const limited = { status: 403, body: "403 Forbidden (Rate Limit Exceeded)" };
  const { sandbox, seen } = loadCanvasApi([limited, limited]);
  const res = await sandbox.fetchWithRetry("https://school.test/api/v1/courses");
  assert.equal(res.status, 200);
  assert.equal(seen.length, 3);
});

test("any other 403 is final, as before", async () => {
  const { sandbox, seen } = loadCanvasApi([{ status: 403, body: "unauthorized" }]);
  const res = await sandbox.fetchWithRetry("https://school.test/api/v1/courses");
  assert.equal(res.status, 403);
  assert.equal(seen.length, 1);
});

test("a 403 whose body never finishes does not hang the export", async () => {
  // The fetch deadline ends with the headers, so the throttling check has to
  // bound its own read. A body that never ends counts as an ordinary 403.
  const stalled = new ReadableStream({ start() {} });
  const { sandbox, seen } = loadCanvasApi([{ status: 403, body: stalled }]);
  const res = await sandbox.fetchWithRetry("https://school.test/api/v1/courses");
  assert.equal(res.status, 403);
  assert.equal(seen.length, 1);
});
