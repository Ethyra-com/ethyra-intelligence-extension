/**
 * The manifest is a contract with a parser, so it gets tested like one.
 *
 *   node --test "ethyra/*.test.mjs"
 *
 * Named explicitly rather than `node --test ethyra/`, which would also try to
 * execute `manifest.js` itself as a test file.
 *
 * No dependencies and no browser: `manifest.js` is pure for exactly this
 * reason. The shape rules it encodes are enforced on the backend and a
 * violation fails an upload, which is a week-later discovery in a student's
 * empty learning graph rather than an error anyone sees at the time.
 */

import { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const {
  MANIFEST_NAME,
  ROLE_INSTRUCTION,
  ROLE_SUBMISSION,
  buildManifest,
  manifestAssignment,
  manifestCourse,
  validateManifest,
} = require("./manifest.js");

const COURSE = "AP World History";
const ASSIGNMENT = `${COURSE}/Essay 3`;
const ESSAY = `${ASSIGNMENT}/my-essay.docx`;
const CRITERIA = `${ASSIGNMENT}/Grading Criteria.pdf`;

// Deliberately carries everything Canvas would return, including the marks, so
// the "no marks" tests below are proving they are DROPPED rather than proving
// they were never fetched.
const canvasAssignment = {
  id: 891011,
  name: "Essay 3: Decolonisation",
  description: "<p>Write <strong>800 words</strong> on decolonisation.</p>",
  points_possible: 100,
  due_at: "2026-03-04T23:59:00Z",
  rubric: [{ id: "_1234", description: "Thesis", long_description: "A clear claim", points: 4 }],
  score_statistics: { mean: 81.2, median: 83, made_up_field: 9 },
};

const canvasSubmission = {
  submitted_at: "2026-03-04T21:12:00Z",
  score: 88,
  grade: "B+",
  submission_type: "online_upload",
  submission_comments: [
    { author_name: "Ms Harper", comment: "Strong thesis.", created_at: "2026-03-07T10:00:00Z", attempt: 2 },
  ],
};

function build({ files = null, assignment = canvasAssignment, submission = canvasSubmission } = {}) {
  return buildManifest({
    canvasHost: "school.instructure.com",
    extensionVersion: "0.1.0",
    capturedAt: "2026-09-17T12:00:00.000Z",
    student: { id: 12345, sortable_name: "Miguel, Santi" },
    courses: [
      manifestCourse({
        course: { id: 4567, name: COURSE, course_code: "APWH-11", term: { name: "Fall 2026" } },
        path: COURSE,
        assignments: [
          manifestAssignment({
            assignment,
            submission,
            path: ASSIGNMENT,
            files: files || [{ path: ESSAY, role: ROLE_SUBMISSION, attempt: 2 }],
          }),
        ],
      }),
    ],
  });
}

test("carries what a Canvas personal export cannot state", () => {
  const m = build();
  const course = m.courses[0];
  const a = course.assignments[0];

  assert.equal(m.manifest_version, 1);
  assert.equal(m.source, "extension");
  assert.equal(m.student.name, "Miguel, Santi");
  assert.equal(course.course_code, "APWH-11");
  assert.equal(course.term, "Fall 2026");
  assert.equal(a.due_at, "2026-03-04T23:59:00.000Z");
  assert.equal(a.submitted_at, "2026-03-04T21:12:00.000Z");
  assert.match(a.instructions_html, /800 words/);
  assert.equal(a.rubric[0].description, "Thesis");
});

test("carries NO marks, even when Canvas hands them over", () => {
  // The fixtures above include score, grade, points_possible, the class
  // statistics and the instructor's comment thread. None of it may survive: the
  // product measures what the work demonstrates against ACT standards, and a
  // teacher's mark is a different judgement against a different rubric.
  const a = build().courses[0].assignments[0];
  for (const field of [
    "score",
    "grade",
    "points_possible",
    "score_statistics",
    "teacher_comments",
    "rubric_assessment",
  ]) {
    assert.equal(a[field], undefined, `${field} must not reach the manifest`);
  }
  // And nowhere else in the document either.
  const serialised = JSON.stringify(build());
  assert.ok(!serialised.includes("B+"), "a grade leaked into the manifest");
  assert.ok(!serialised.includes("Ms Harper"), "an instructor comment leaked into the manifest");
  assert.ok(!serialised.includes("81.2"), "a class statistic leaked into the manifest");
});

test("ids are strings — Canvas sends them both ways depending on the Accept header", () => {
  const m = build();
  assert.equal(m.courses[0].canvas_course_id, "4567");
  assert.equal(m.courses[0].assignments[0].canvas_assignment_id, "891011");
});

test("rubric is rebuilt by allowlist, not passed through", () => {
  const criterion = build().courses[0].assignments[0].rubric[0];
  assert.deepEqual(Object.keys(criterion).sort(), ["description", "long_description", "points"]);
  assert.equal(criterion.id, undefined);
});

test("a locked assignment records no handout rather than an empty one", () => {
  const a = build({ assignment: { ...canvasAssignment, locked_for_user: true } }).courses[0].assignments[0];
  assert.equal(a.instructions_locked, true);
  // "" would claim the teacher wrote no instructions. Different, and wrong.
  assert.equal(a.instructions_html, null);
});

test("a malformed date becomes unknown here, not a 400 from the backend", () => {
  const a = build({ assignment: { ...canvasAssignment, due_at: "not a date" } }).courses[0].assignments[0];
  assert.equal(a.due_at, null);
});

// ── validateManifest: catching upload failures before the upload ──────────

test("a well-formed manifest and archive agree", () => {
  const m = build();
  assert.deepEqual(validateManifest(m, [ESSAY, MANIFEST_NAME]), []);
});

test("the teacher's file inside a submission is allowed, once something is the student's", () => {
  const m = build({
    files: [
      { path: ESSAY, role: ROLE_SUBMISSION, attempt: 2 },
      { path: CRITERIA, role: ROLE_INSTRUCTION },
    ],
  });
  assert.deepEqual(validateManifest(m, [ESSAY, CRITERIA, MANIFEST_NAME]), []);
});

test("an assignment of nothing but the teacher's materials is rejected", () => {
  const m = build({ files: [{ path: CRITERIA, role: ROLE_INSTRUCTION }] });
  const problems = validateManifest(m, [CRITERIA, MANIFEST_NAME]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no submitted work/);
});

test("a manifest path with no file behind it is caught here, not in a 400", () => {
  const m = build();
  const problems = validateManifest(m, [MANIFEST_NAME]);
  assert.match(problems.join(" "), /in the manifest but not in the archive/);
});

test("an archive file no assignment claims is caught — the backend would drop it silently", () => {
  const m = build();
  const stray = `${ASSIGNMENT}/mystery.pdf`;
  const problems = validateManifest(m, [ESSAY, stray, MANIFEST_NAME]);
  assert.match(problems.join(" "), /not listed in the manifest/);
});

test("an unknown role is caught", () => {
  const m = build({ files: [{ path: ESSAY, role: "peer_review" }] });
  assert.match(validateManifest(m, [ESSAY, MANIFEST_NAME]).join(" "), /has role "peer_review"/);
});

test("a file outside its assignment is caught", () => {
  const m = build({ files: [{ path: `${COURSE}/Other Essay/theirs.docx`, role: ROLE_SUBMISSION }] });
  const problems = validateManifest(m, [`${COURSE}/Other Essay/theirs.docx`, MANIFEST_NAME]);
  assert.match(problems.join(" "), /is not inside/);
});

test("a course path deeper than one folder is caught", () => {
  const m = build();
  m.courses[0].path = "Fall 2026/AP World History";
  assert.match(validateManifest(m, [ESSAY, MANIFEST_NAME]).join(" "), /exactly one folder/);
});
