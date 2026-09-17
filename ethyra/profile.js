/**
 * What an Ethyra export collects, and what it deliberately does not.
 *
 * Original to this fork.
 *
 * ── Subtraction by configuration, not by deletion ─────────────────────
 *
 * Upstream's `downloadCourse` already branches on `settings.contentTypes` for
 * all eleven content types, so narrowing the scope needs no code removed — it
 * needs one object. That matters: every line left in place is a line
 * `git merge upstream/main` can still deliver a Canvas fix to.
 *
 * ── Why the mirror is off ─────────────────────────────────────────────
 *
 * Course files, pages, modules, discussions, announcements, quizzes and the
 * syllabus are teacher- or peer-authored. None of them is evidence about this
 * student, and the backend measures proficiency from the text of the files it
 * is given — so a course mirror is not merely wasted bandwidth, it is a way to
 * produce a proficiency level, with a supporting quote, for prose the student
 * never wrote.
 *
 * It is also the difference between "export my own coursework for analysis" and
 * "download a Canvas course, and also upload it somewhere", and only the first
 * survives the Chrome Web Store's single-purpose rule with a straight face.
 *
 * ── Why `grades` is off despite us wanting grades ─────────────────────
 *
 * `types.grades` writes a `Grades.csv` at the archive root. The manifest already
 * carries `score`, `grade` and `points_possible` per assignment, structured, and
 * a root-level CSV would be an archive entry no assignment claims — which the
 * backend reports as an unclaimed file and drops. The data is kept; the file is
 * not.
 *
 * ── Why `assignments` is on when we emit no assignment documents ──────
 *
 * That flag gates the loop where `description` and the rubric are read and where
 * teacher-attached files are harvested. The loop runs; only its final
 * `buildDocEntry` push is skipped, because the manifest carries the handout as
 * data and a rendered copy would be a second unclaimed file.
 */

const ETHYRA_CONTENT_TYPES = Object.freeze({
  // On: the student's own work, and what was asked of them.
  assignments: true, // descriptions, rubrics, due dates, linked-file harvest
  submissions: true, // every attempt, attachments, inline text, comments
  linkedFiles: true, // files the teacher attached to a description

  // Off: everything that is not evidence about this student.
  files: false,
  pages: false,
  modules: false,
  discussions: false,
  announcements: false,
  quizzes: false,
  syllabus: false,
  grades: false, // kept in the manifest instead — see above
});

// The role constants live in `manifest.js` and are deliberately NOT repeated
// here. Content scripts share one scope, so a second `const ROLE_SUBMISSION`
// would be a redeclaration that throws at load — and two names for one value is
// how they drift apart anyway.

/** Per-file cap. Mirrors the backend's `MAX_ARTIFACT_BYTES`; over it the upload fails. */
const ETHYRA_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Whole-archive cap, across every course. Mirrors the backend's `MAX_UPLOAD_BYTES`. */
const ETHYRA_MAX_TOTAL_BYTES = 500 * 1024 * 1024;

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ETHYRA_CONTENT_TYPES,
    ETHYRA_MAX_FILE_BYTES,
    ETHYRA_MAX_TOTAL_BYTES,
  };
}
