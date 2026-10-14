/**
 * Course structure: syllabus, modules, pages, quizzes, outcomes and course
 * documents, read as the student and attached to each course of the manifest.
 *
 *   node --test "ethyra/*.test.mjs"
 *
 * Runs `structure.js` and `collect.js` against a fake Canvas served through the
 * real `fetchWithRetry`, so pagination, 403s and retries take the same path
 * they take in a browser.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://school.test";
const quiet = { log() {}, info() {}, warn() {}, error() {}, table() {} };
// Plain JSON copies: the sandbox's arrays are not deepEqual to this realm's.
const plain = (v) => JSON.parse(JSON.stringify(v));

/**
 * A fake Canvas. `routes` maps a path-and-query under the origin to an answer:
 * `{ status, body, next }` (`next` becomes a Link rel="next"), an array (a 200
 * with that body), or a function of the URL. Anything unrouted is a 404.
 */
function load(routes, { downloadCourse } = {}) {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    const key = url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : url;
    let answer = routes[key];
    if (typeof answer === "function") answer = answer(key);
    if (answer === undefined) answer = { status: 404, body: { errors: [] } };
    if (answer instanceof Error) throw answer;
    if (Array.isArray(answer) || !("body" in answer || "status" in answer)) answer = { body: answer };
    const { status = 200, body = null, next } = answer;
    const headers = next ? { link: `<${ORIGIN}${next}>; rel="next"` } : {};
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  const sandbox = vm.createContext({
    console: quiet,
    document: undefined,
    fetch,
    AbortController,
    TextDecoder,
    URL,
    Response,
    // Every wait at a hundredth of its length.
    setTimeout: (fn, ms = 0) => setTimeout(fn, ms / 100),
    clearTimeout,
    downloadCourse,
  });
  for (const f of ["ethyra/profile.js", "ethyra/manifest.js", "helpers.js", "canvas-api.js", "ethyra/archive.js", "ethyra/structure.js", "ethyra/collect.js"]) {
    vm.runInContext(readFileSync(join(ROOT, f), "utf8"), sandbox, { filename: f });
  }
  return { sandbox, seen };
}

const C = "/api/v1/courses/7";
const read = (sandbox, extra = {}) =>
  sandbox.fetchCourseStructure({ origin: ORIGIN, courseId: "7", ...extra }).then(plain);

// ── Each section ─────────────────────────────────────────────────────────────

test("modules are read across pages, with locked and future items and their due dates", async () => {
  const { sandbox } = load({
    [`${C}/modules?include[]=items&include[]=content_details&per_page=100`]: {
      body: [
        {
          name: "Unit 1",
          position: 1,
          items: [
            { title: "Cell Theory Reading", type: "Page", position: 1, indent: 0 },
            { title: "Lab 1", type: "Assignment", position: 2, indent: 1, content_details: { due_at: "2018-09-20T05:59:59Z", locked_for_user: true } },
          ],
        },
      ],
      next: `${C}/modules?page=2`,
    },
    [`${C}/modules?page=2`]: [
      // Canvas leaves `items` out of a big module and points at them instead.
      { name: "Unit 2", position: 2, items_url: `${ORIGIN}${C}/modules/2/items` },
    ],
    [`${C}/modules/2/items?include[]=content_details&per_page=100`]: [
      { title: "Unit 2 Test", type: "Quiz", position: 1, indent: 0, content_details: { due_at: "2018-10-30T05:59:59Z" } },
    ],
  });
  const { structure } = await read(sandbox, { withFiles: false });
  assert.deepEqual(structure.modules, [
    {
      name: "Unit 1",
      position: 1,
      items: [
        { title: "Cell Theory Reading", type: "Page", position: 1, indent: 0, due_at: null },
        { title: "Lab 1", type: "Assignment", position: 2, indent: 1, due_at: "2018-09-20T05:59:59.000Z" },
      ],
    },
    {
      name: "Unit 2",
      position: 2,
      items: [{ title: "Unit 2 Test", type: "Quiz", position: 1, indent: 0, due_at: "2018-10-30T05:59:59.000Z" }],
    },
  ]);
});

test("pages carry their bodies, capped at 64,000 characters and 200 pages", async () => {
  const list = Array.from({ length: 150 }, (_, i) => ({ title: `Page ${i}`, url: `page-${i}`, updated_at: "2018-09-17T00:00:00Z" }));
  const routes = {
    [`${C}/pages?per_page=100&published=true`]: { body: list.slice(0, 100), next: `${C}/pages?page=2` },
    [`${C}/pages?page=2`]: { body: list.slice(100), next: `${C}/pages?page=3` },
    [`${C}/pages?page=3`]: { body: list.slice(0, 100).map((p) => ({ ...p, url: `more-${p.url}` })), next: `${C}/pages?page=4` },
  };
  for (const p of list) routes[`${C}/pages/${p.url}`] = { body: { ...p, body: `<p>${p.title}</p>` } };
  routes[`${C}/pages/page-0`] = { body: { body: "x".repeat(70_000) } };
  const { sandbox, seen } = load(routes);
  const { structure } = await read(sandbox, { withFiles: false });

  assert.equal(structure.pages.length, 200, "capped at 200 pages");
  assert.ok(!seen.some((u) => u.endsWith("pages?page=4")), "stops paginating at the cap");
  assert.equal(structure.pages[0].body_html.length, 64_000);
  assert.deepEqual(structure.pages[1], {
    title: "Page 1",
    url: "page-1",
    body_html: "<p>Page 1</p>",
    updated_at: "2018-09-17T00:00:00.000Z",
  });
  // A page whose body cannot be read keeps its title.
  assert.equal(structure.pages[150].body_html, null);
});

test("syllabus, quizzes (metadata only) and outcomes", async () => {
  const { sandbox, seen } = load({
    [`${C}?include[]=syllabus_body`]: { body: { id: "7", syllabus_body: "<h1>Biology</h1>" } },
    [`${C}/quizzes?per_page=100`]: [
      { title: "Quiz 1", description: "<p>Cells</p>", due_at: "2018-09-21T05:59:59Z", question_count: 10, questions: ["never"] },
    ],
    [`${C}/outcome_group_links?per_page=100`]: [
      { outcome: { title: "LS1.A", description: "y".repeat(3_000) } },
      { outcome: { title: "" } },
    ],
  });
  const { structure } = await read(sandbox, { withFiles: false });
  assert.equal(structure.syllabus_html, "<h1>Biology</h1>");
  assert.deepEqual(structure.quizzes, [
    { title: "Quiz 1", description_html: "<p>Cells</p>", due_at: "2018-09-21T05:59:59.000Z", question_count: 10 },
  ]);
  assert.equal(structure.outcomes.length, 1);
  assert.equal(structure.outcomes[0].description.length, 2_000);
  assert.ok(!seen.some((u) => /questions|submissions/.test(u)), "no quiz questions, no submissions");
});

test("a section Canvas refuses (401/403/404, or a network failure) is left out, and the rest still come", async () => {
  const { sandbox } = load({
    [`${C}?include[]=syllabus_body`]: { status: 401, body: {} },
    [`${C}/modules?include[]=items&include[]=content_details&per_page=100`]: [],
    [`${C}/pages?per_page=100&published=true`]: { status: 403, body: { status: "unauthorized" } },
    [`${C}/quizzes?per_page=100`]: new TypeError("Failed to fetch"),
    // outcome_group_links: unrouted, a 404
    [`${C}/files?per_page=100`]: { status: 403, body: { status: "unauthorized" } },
  });
  const { structure, documents } = await read(sandbox);
  assert.deepEqual(structure, { modules: [] }, "only what could be read; empty is not absent");
  assert.equal(documents, null, "a refused file list means no structure.files at all");
});

test("a refusal partway through a list drops the list rather than sending half of it", async () => {
  const { sandbox } = load({
    [`${C}/quizzes?per_page=100`]: { body: [{ title: "Quiz 1" }], next: `${C}/quizzes?page=2` },
    [`${C}/quizzes?page=2`]: { status: 403, body: {} },
  });
  const { structure } = await read(sandbox, { withFiles: false });
  assert.ok(!("quizzes" in structure));
});

// ── Course documents ─────────────────────────────────────────────────────────

const doc = (id, name, extra = {}) => ({
  id: String(id),
  display_name: name,
  "content-type": "application/octet-stream",
  size: 1000,
  url: `${ORIGIN}/files/${id}/download?verifier=v`,
  ...extra,
});

test("only readable documents go, not media, not over the per-file cap, not ones the export already has", async () => {
  const { sandbox } = load({
    [`${C}/files?per_page=100`]: [
      doc(1, "Unit 1 Notes.pdf", { "content-type": "application/pdf" }),
      doc(2, "Essay.docx"),
      doc(3, "notes", { "content-type": "text/plain" }), // by content type
      doc(4, "Page.HTM"),
      doc(5, "Lecture.mp4", { "content-type": "video/mp4" }),
      doc(6, "photo.jpg", { "content-type": "image/jpeg" }),
      doc(7, "trick.mp4", { "content-type": "text/plain" }), // a media extension is never a document
      doc(8, "huge.pdf", { size: 51 * 1024 * 1024 }),
      doc(9, "locked.pdf", { locked_for_user: true, url: "" }),
      doc(10, "handout.pdf"), // already attached to an assignment
      doc(11, "data.xlsx"),
      doc(12, "slides.pptx"),
      doc(13, "README.md"),
      doc(14, "a.rtf"),
      doc(15, "b.odt"),
      doc(16, "c.doc"),
      doc(17, "d.txt"),
      doc(18, "e.html"),
      doc(19, "archive.zip"),
    ],
  });
  const { documents } = await read(sandbox, { claimedIds: new Set(["10"]) });
  assert.deepEqual(
    documents.map((d) => d.id),
    ["1", "2", "3", "4", "11", "12", "13", "14", "15", "16", "17", "18"]
  );
});

test("at most 300 course documents, and the listing stops there", async () => {
  const many = (from) => Array.from({ length: 100 }, (_, i) => doc(from + i, `f${from + i}.pdf`));
  const { sandbox, seen } = load({
    [`${C}/files?per_page=100`]: { body: many(0), next: `${C}/files?page=2` },
    [`${C}/files?page=2`]: { body: many(100), next: `${C}/files?page=3` },
    [`${C}/files?page=3`]: { body: many(200), next: `${C}/files?page=4` },
    [`${C}/files?page=4`]: { body: many(300) },
  });
  const { documents } = await read(sandbox);
  assert.equal(documents.length, 300);
  assert.ok(!seen.some((u) => u.endsWith("files?page=4")));
});

// ── Through collectExport ────────────────────────────────────────────────────

const COURSE = { id: "7", name: "Biology", course_code: "BIO", term: { name: "2018" } };
const ESSAY = { id: "71", name: "Essay" };

/** One course with one submitted essay, which is also file 10 in Canvas. */
function canvas(extra = {}) {
  return {
    "/api/v1/users/self": { body: { id: "99" } },
    "/api/v1/courses?per_page=100&enrollment_state=active&include[]=term": [COURSE],
    "/api/v1/courses?per_page=100&enrollment_state=completed&include[]=term": [],
    [`${C}?include[]=syllabus_body`]: { body: { syllabus_body: "<p>Syllabus</p>" } },
    [`${C}/modules?include[]=items&include[]=content_details&per_page=100`]: [
      { name: "Unit 1", position: 1, items: [{ title: "Essay", type: "Assignment", position: 1, indent: 0 }] },
    ],
    [`${C}/files?per_page=100`]: [
      doc(1, "Unit 1 Notes.pdf", { "content-type": "application/pdf" }),
      doc(2, "Same as essay.txt"),
      doc(10, "essay.txt"),
    ],
    ...extra,
  };
}

const downloadCourse = async (courseId, name, origin, log, recorder) => {
  recorder.recordAssignment(ESSAY);
  recorder.recordSubmission(ESSAY, { workflow_state: "submitted" });
  return [{ path: recorder.assignmentFolder(ESSAY), filename: "essay.txt", size: 5, url: "x", canvasId: "10", role: "submission" }];
};

/** A per-file sender that names each file by its URL, so tests can tell them apart. */
function perFileSender(calls) {
  return async ({ files, optional }) => {
    calls.push({ files: files.map((f) => f.filename), optional: Boolean(optional) });
    const hashes = new Map();
    for (const f of files) {
      const sha = f.filename === "essay.txt" || f.filename === "Same as essay.txt" ? "e".repeat(64) : String(f.canvasId).padStart(64, "0");
      hashes.set(`${f.path}${f.filename}`, { sha256: sha, size: f.size });
    }
    return { failed: [], hashes };
  };
}

test("per-file: structure rides on the course, and its documents are sent after the work, as optional", async () => {
  const { sandbox } = load(canvas(), { downloadCourse });
  const calls = [];
  const { manifest, files } = await sandbox.collectExport({ origin: ORIGIN, extensionVersion: "0", sendCourse: perFileSender(calls) });

  assert.deepEqual(plain(calls), [
    { files: ["essay.txt"], optional: false },
    { files: ["Unit 1 Notes.pdf", "Same as essay.txt"], optional: true },
  ], "work first; the essay (file 10) is not listed again as a course file");

  const course = plain(manifest.courses[0]);
  assert.equal(manifest.manifest_version, 1);
  assert.equal(course.structure.syllabus_html, "<p>Syllabus</p>");
  assert.equal(course.structure.modules[0].items[0].title, "Essay");
  assert.ok(!("pages" in course.structure), "unrouted pages (404) are left out");
  assert.deepEqual(course.structure.files, [
    { sha256: "1".padStart(64, "0"), size: 1000, display_name: "Unit 1 Notes.pdf", content_type: "application/pdf" },
  ], "byte-identical to the essay, so not listed twice");
  // Course documents are never archive entries.
  assert.deepEqual(plain(files.map((f) => f.filename)), ["essay.txt"]);
});

test("one-zip fallback: no structure.files, and no course document in the archive", async () => {
  const { sandbox } = load(canvas(), { downloadCourse });
  const calls = [];
  const zip = async ({ files, optional }) => {
    calls.push({ n: files.length, optional: Boolean(optional) });
    return { failed: [], hashes: null };
  };
  const { manifest, files } = await sandbox.collectExport({ origin: ORIGIN, extensionVersion: "0", sendCourse: zip });

  const course = plain(manifest.courses[0]);
  assert.ok(course.structure, "the rest of the structure still goes");
  assert.ok(!("files" in course.structure));
  assert.deepEqual(plain(files.map((f) => f.filename)), ["essay.txt"]);
  assert.ok(!calls.some((c) => c.optional), "course documents are never offered to a zip");
  // And the manifest agrees with the archive.
  const paths = new Set(files.map((f) => `${f.path}${f.filename}`));
  paths.add("ethyra-manifest.json");
  assert.deepEqual(plain(sandbox.validateManifest(manifest, paths)), []);
});

test("no structure is read from a course the student teaches", async () => {
  const { sandbox, seen } = load(canvas(), {
    downloadCourse: async () => {
      const err = new Error("you teach this course");
      err.code = "ETHYRA_NOT_A_STUDENT";
      throw err;
    },
  });
  await sandbox.collectExport({ origin: ORIGIN, extensionVersion: "0" });
  assert.ok(!seen.some((u) => u.includes(`${C}/`) || u.includes(`${C}?`)), seen.join("\n"));
});

test("course documents over the size cap stop quietly; a failure sending them never fails the export", async () => {
  for (const sendDocs of [
    async () => ({ failed: [], hashes: new Map(), capped: true }),
    async () => {
      throw new Error("Could not reach Ethyra.");
    },
  ]) {
    const { sandbox } = load(canvas(), { downloadCourse });
    const work = perFileSender([]);
    const sendCourse = (args) => (args.optional ? sendDocs(args) : work(args));
    const { manifest } = await sandbox.collectExport({ origin: ORIGIN, extensionVersion: "0", sendCourse });
    assert.equal(manifest.courses.length, 1);
    assert.equal(manifest.courses[0].assignments.length, 1);
  }
});

test("a course whose every structure endpoint fails is exported exactly as before, with an empty structure", async () => {
  const routes = canvas();
  for (const key of Object.keys(routes)) if (key.startsWith(C)) delete routes[key];
  const { sandbox } = load(routes, { downloadCourse });
  const { manifest } = await sandbox.collectExport({ origin: ORIGIN, extensionVersion: "0", sendCourse: perFileSender([]) });
  assert.deepEqual(plain(manifest.courses[0].structure), {});
  assert.equal(manifest.courses[0].assignments[0].files.length, 1);
});
