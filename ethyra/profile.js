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

/**
 * Whole-archive cap, across every course. Mirrors the backend's
 * `MAX_DIRECT_UPLOAD_BYTES`: the archive goes straight to blob storage, so no
 * request or server memory bounds it. A real export with every past course was
 * 1.2 GB after unreadable media was left out.
 */
const ETHYRA_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * The one-zip fallback's cap, for a backend without per-file upload. Mirrors the
 * backend's `MAX_UPLOAD_BYTES`: that route takes the whole archive in one
 * request, so it is far below `ETHYRA_MAX_TOTAL_BYTES`.
 */
const ETHYRA_MAX_ZIP_BYTES = 500 * 1024 * 1024;

/**
 * File types the backend stores but cannot read, so they are never sent.
 *
 * Mirrors `UNSUPPORTED` in the backend's `extraction.py`, which sniffs bytes:
 * anything with an `ftyp` box (every MP4/MOV video, M4A audio and HEIC photo),
 * OLE (.doc/.xls/.ppt), slides, and zips (which is what .odt and iWork files
 * are). Other binaries with no reader — GIF, TIFF, MP3, WAV — land in its
 * "a file type we can't read yet" bucket.
 *
 * These are most of an export's bytes: a real one was 1.7 GB, mostly video and
 * spoken-language recordings, none of it analysable. Uploading them costs the
 * student the upload and buys nothing. When the backend learns a format, take
 * it off this list.
 *
 * Matched on the extension because the bytes are not fetched until the archive
 * is built, which is after this decision.
 */
const ETHYRA_UNREADABLE_EXTENSIONS = new Set([
  // video
  "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "3gp", "3g2", "mpg", "mpeg", "mts", "m2ts",
  // audio
  "mp3", "m4a", "wav", "aac", "ogg", "oga", "opus", "flac", "wma", "aif", "aiff", "amr", "caf",
  // images with no reader (JPEG, PNG and WebP are OCR'd)
  "heic", "heif", "avif", "gif", "tif", "tiff", "bmp",
  // legacy Office, slides, OpenDocument, iWork
  "doc", "xls", "ppt", "pps", "pptx", "ppsx", "odt", "ods", "odp", "pages", "numbers", "key",
  // archives
  "zip", "rar", "7z", "tar", "gz",
]);

/**
 * Thrown when a course is one the user teaches rather than takes.
 *
 * ── Why a role check exists at all ────────────────────────────────────
 *
 * Upstream serves teachers and students alike, and its collector branches on
 * `fetchCourseRole` — true for `teacher`, `ta` and `designer`. The teacher
 * branch fetches every student's submissions, comments and rubric marks,
 * because mirroring a course you teach is the thing it is for.
 *
 * This fork measures one person's own work. A course the user teaches has none
 * of that in it, so there is nothing to collect and every reason not to look:
 * the teacher branch shares `renderSubmission` with the student branch, and
 * that function records into the Ethyra recorder. Nothing reaches the archive
 * today — the teacher path files land under `Submissions/<assignment>/<student>/`
 * while `collect.js` claims only files sitting in the assignment's own folder,
 * so they are dropped — but that is a path mismatch, not a decision. One
 * refactor aligning those folders would begin uploading other students' work
 * under the teacher's account, and nothing would fail.
 *
 * The check is therefore where it cannot be bypassed: before any submission is
 * fetched, not after.
 *
 * Carried as a code rather than matched on message text, so `collect.js` can
 * tell a course deliberately skipped from a course that failed.
 */
const ETHYRA_NOT_A_STUDENT = "ETHYRA_NOT_A_STUDENT";

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ETHYRA_CONTENT_TYPES,
    ETHYRA_MAX_FILE_BYTES,
    ETHYRA_MAX_TOTAL_BYTES,
    ETHYRA_MAX_ZIP_BYTES,
    ETHYRA_NOT_A_STUDENT,
    ETHYRA_UNREADABLE_EXTENSIONS,
  };
}
