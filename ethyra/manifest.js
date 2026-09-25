/**
 * Build `ethyra-manifest.json` — the contract with the Ethyra backend.
 *
 * Original to this fork. Nothing upstream reads or writes this file.
 *
 * ── Why the archive carries a manifest at all ─────────────────────────
 *
 * A Canvas personal data export carries no metadata whatsoever: no dates, no
 * grades, no course ids, no handout, and no way to tell a file the student
 * submitted from one the teacher attached. Everything the Ethyra backend needed
 * beyond "these bytes were submitted for something called X" had to be inferred
 * downstream by a language model.
 *
 * This extension reads the Canvas REST API first, so it knows all of it. The
 * manifest is where it says so, and the backend switches from inferring to
 * reading the moment it finds one.
 *
 * ── The field that matters most is `role` ─────────────────────────────
 *
 * The backend measures a student's proficiency from the text of their files. A
 * teacher's exemplar essay read as a submission produces a level — with a
 * verbatim supporting quote — for prose the student never wrote, and nothing
 * downstream can distinguish that from a correct reading. Without a stated role
 * the backend falls back to guessing from the filename.
 *
 * ── The marks, and what still stays behind ────────────────────────────
 *
 * The item's own mark travels: `points_possible`, `score` and `grade`. The
 * class window shows each gradebook item with its grade beside what the work
 * shows, and the student sees those grades in Canvas already. The backend
 * stores them and never puts one in a prompt — a model shown the mark
 * reconciles its reading to it.
 *
 * Still not carried: the class `score_statistics`, the rubric assessment and
 * the instructor's comment thread. Those are other people's judgements about
 * the work, not facts about the gradebook item.
 *
 * `due_at` and `submitted_at` are kept. They are what lets the backend order a
 * student's work by when it was due instead of by a filename heuristic.
 *
 * ── An item with nothing turned in ────────────────────────────────────
 *
 * Listed with `files: []`. It is a gradebook row — its date and grade show on
 * the class window as "No writing to read." — and the backend settles it
 * without an agent call.
 *
 * ── Shape rules the backend enforces ──────────────────────────────────
 *
 * These are validated on the other side and a violation fails the upload, so
 * they are worth stating here rather than discovering in a 400:
 *
 *   - a course `path` is exactly ONE path component
 *   - an assignment `path` starts with its course's path
 *   - a file `path` starts with its assignment's path
 *   - every path must exist in the archive, and every archive entry should be
 *     claimed by exactly one assignment — unclaimed files are dropped with a
 *     warning rather than guessed at
 *   - `role` is `submission` or `instruction_attachment`, nothing else
 *
 * Every other field is optional, and **absent means unknown, never a default**.
 * A missing `due_at` makes the backend fall back to ordering by filename; a
 * `due_at` of the epoch would invent a chronology.
 *
 * ── Pure on purpose ───────────────────────────────────────────────────
 *
 * No `chrome.*`, no DOM, no fetch. That is what lets `manifest.test.mjs` run it
 * under plain node, which matters because the shape rules above are the kind of
 * thing that breaks silently and is discovered a week later in a student's empty
 * learning graph.
 */

const MANIFEST_VERSION = 1;

/** Mirrors `CanvasArtifact.role` in the backend. */
const ROLE_SUBMISSION = "submission";
const ROLE_INSTRUCTION = "instruction_attachment";

/** A string, trimmed and capped, or null. Null is "not stated". */
function text(value, limit = 512) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

/** A finite number, or null. Canvas sends `null` for an ungraded submission. */
function number(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** A Canvas id as a string. Canvas sends these as numbers or strings depending on the header. */
function id(value) {
  if (value === null || value === undefined || value === "") return null;
  return String(value).slice(0, 64);
}

/**
 * An ISO 8601 instant, or null.
 *
 * Canvas already sends ISO; this re-parses rather than passing it through so a
 * malformed date becomes "unknown" here instead of a 400 from the backend's own
 * parser, which is a much worse place to find out.
 */
function timestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The rubric definition, reduced to what the backend will actually read.
 *
 * Rebuilt key by key rather than passed through. Canvas's rubric objects carry
 * ids, vendor GUIDs and nested rating tiers that nothing downstream reads, and
 * the backend rebuilds them by allowlist anyway — sending the rest is bytes
 * across the wire to be discarded.
 */
function rubric(criteria) {
  if (!Array.isArray(criteria)) return null;
  const out = [];
  for (const criterion of criteria) {
    if (!criterion || typeof criterion !== "object") continue;
    const description = text(criterion.description, 2000);
    const longDescription = text(criterion.long_description, 2000);
    if (!description && !longDescription) continue;
    const entry = { description: description || longDescription };
    if (description && longDescription) entry.long_description = longDescription;
    const points = number(criterion.points);
    if (points !== null) entry.points = points;
    out.push(entry);
  }
  return out.length ? out : null;
}

/**
 * One assignment.
 *
 * `submission` is the DETAIL object from `/submissions/self`, not the summary
 * that rides along on the assignment list — only the detail carries
 * `submission_history` and `submission_comments`.
 *
 * `files` are already-built `{ path, role, attempt }` entries, because the paths
 * have to match the archive exactly and the caller is what puts the bytes there.
 */
function manifestAssignment({ assignment, submission, path, files }) {
  const locked = assignment.locked_for_user === true;

  // A student who cannot open an assignment gets no description from Canvas —
  // it withholds the field rather than returning an empty one. Sending "" would
  // claim the teacher wrote no instructions, which is a different and wrong
  // thing to say, so this stays null and flags why.
  const instructions = locked ? null : text(assignment.description, 64_000);

  return {
    path,
    canvas_assignment_id: id(assignment.id),
    name: text(assignment.name, 512),
    assignment_group: text(assignment.assignment_group_name, 255),
    instructions_html: instructions,
    instructions_locked: locked,
    rubric: rubric(assignment.rubric),
    // Dates, not marks. These are what let the backend order a student's work by
    // when it was actually due instead of by filename — the only chronology a
    // single upload has.
    due_at: timestamp(assignment.due_at),
    submitted_at: timestamp(submission?.submitted_at),
    submission_type: text(submission?.submission_type, 64),
    // The item's own mark, shown beside the work and never prompted. Null when
    // ungraded or not yet posted — Canvas withholds an unposted score.
    points_possible: number(assignment.points_possible),
    score: number(submission?.score),
    grade: text(submission?.grade, 32),
    files,
  };
}

/** One course. `path` is a single component — the backend rejects anything deeper. */
function manifestCourse({ course, path, assignments }) {
  return {
    path,
    canvas_course_id: id(course.id),
    name: text(course.name, 512),
    course_code: text(course.course_code, 255),
    term: text(course.term?.name, 255),
    assignments,
  };
}

/**
 * The whole manifest.
 *
 * `captured_at` is passed in rather than read from the clock so the caller owns
 * the one impure thing in this module and the tests stay deterministic.
 */
function buildManifest({ canvasHost, extensionVersion, student, courses, capturedAt }) {
  return {
    manifest_version: MANIFEST_VERSION,
    source: "extension",
    extension_version: extensionVersion || null,
    captured_at: capturedAt,
    canvas_host: canvasHost || null,
    // ── No Canvas name, deliberately ──────────────────────────────────
    //
    // This used to carry `sortable_name` — "Reyes, Ava" — and the backend
    // labelled the whole learning profile with it. The result was a product
    // addressing a student by an identity they did not choose here: the name
    // their school put in Canvas, not the name on their Ethyra account, and
    // the two are routinely different (a legal name against a used one, a
    // maiden name, a transliteration, a name since changed).
    //
    // The account is the identity that belongs to the student, and the backend
    // already knows it — every request arrives with a verified token carrying
    // it. Sending a second, worse name invited exactly the mix-up it caused.
    //
    // `canvas_user_id` stays. It is a scoping key, not a label: it says which
    // Canvas account an export came from, which matters when a student has
    // more than one, and nothing renders it.
    student: {
      canvas_user_id: id(student?.id),
    },
    courses,
  };
}

/**
 * Check a built manifest against the archive that will carry it.
 *
 * The backend enforces all of this and fails the upload on a violation — which
 * is the right behaviour there and a terrible way to find out here, after a
 * student has waited out a twenty-minute export. `archivePaths` is the set of
 * entry names the zip will actually contain.
 *
 * Returns a list of human-readable problems; empty means it will be accepted.
 */
function validateManifest(manifest, archivePaths) {
  const problems = [];
  const present = archivePaths instanceof Set ? archivePaths : new Set(archivePaths);
  const claimed = new Set();

  for (const course of manifest.courses || []) {
    const coursePath = course.path || "";
    if (!coursePath || coursePath.includes("/")) {
      problems.push(`Course path must be exactly one folder: ${JSON.stringify(coursePath)}`);
      continue;
    }
    for (const assignment of course.assignments || []) {
      const assignmentPath = assignment.path || "";
      if (!assignmentPath.startsWith(`${coursePath}/`)) {
        problems.push(`Assignment ${JSON.stringify(assignmentPath)} is not inside ${JSON.stringify(coursePath)}`);
        continue;
      }
      let submissions = 0;
      for (const file of assignment.files || []) {
        const filePath = file.path || "";
        if (!filePath.startsWith(`${assignmentPath}/`)) {
          problems.push(`File ${JSON.stringify(filePath)} is not inside ${JSON.stringify(assignmentPath)}`);
        }
        if (file.role !== ROLE_SUBMISSION && file.role !== ROLE_INSTRUCTION) {
          problems.push(`File ${JSON.stringify(filePath)} has role ${JSON.stringify(file.role)}`);
        }
        if (!present.has(filePath)) {
          problems.push(`File ${JSON.stringify(filePath)} is in the manifest but not in the archive`);
        }
        if (claimed.has(filePath)) {
          problems.push(`File ${JSON.stringify(filePath)} is claimed by more than one assignment`);
        }
        claimed.add(filePath);
        if (file.role === ROLE_SUBMISSION) submissions++;
      }
      // An assignment of nothing but the teacher's materials is not evidence
      // about the student, and the backend would spend an agent call to say so.
      // Listed with no files at all is different: a gradebook item with nothing
      // turned in, which the backend keeps for its date and grade.
      if (submissions === 0 && (assignment.files || []).length > 0) {
        problems.push(`Assignment ${JSON.stringify(assignmentPath)} has no submitted work`);
      }
    }
  }

  for (const path of present) {
    if (path === MANIFEST_NAME) continue;
    if (!claimed.has(path)) {
      problems.push(`Archive file ${JSON.stringify(path)} is not listed in the manifest`);
    }
  }

  return problems;
}

const MANIFEST_NAME = "ethyra-manifest.json";

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MANIFEST_NAME,
    MANIFEST_VERSION,
    ROLE_SUBMISSION,
    ROLE_INSTRUCTION,
    buildManifest,
    manifestAssignment,
    manifestCourse,
    validateManifest,
  };
}
