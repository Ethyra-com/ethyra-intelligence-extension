/**
 * Build the fixture set from dev/README.md against a local Canvas.
 *
 * Run:  node dev/seed.mjs
 *
 * ── Why a script rather than clicking through Canvas ──────────────────
 *
 * Two of the fixtures cannot be produced reliably by hand. The 80-character
 * truncation collision needs two assignment titles agreeing to the character,
 * and the multi-attempt case needs a resubmission that does not replace its
 * predecessor. Both are the cases `collect.js` reasons about at length, and both
 * are the ones a tired person clicking through a UI gets subtly wrong.
 *
 * Everything runs as the site admin, with `as_user_id` masquerade for the acts
 * that must belong to the student — a submission recorded against the admin is
 * not evidence about the student and would be skipped by the exporter anyway.
 *
 * Idempotent by name: re-running finds existing courses and users rather than
 * duplicating them. Canvas has no upsert, so this is a lookup-then-create.
 */

import {
  CANVAS,
  api,
  uploadFile,
  findOrCreateUser,
  findOrCreateCourse,
  enrol,
  findOrCreateAssignment,
  submit,
  gradeAndComment,
  sleep,
} from "./canvas.mjs";

const STUDENT_LOGIN = "student@example.com";
const STUDENT_PASSWORD = "password123";
const STUDENT_NAME = "Test Student";

const enc = (s) => new TextEncoder().encode(s);

// A real PNG — 1×1, transparent. Canvas rejects zero-byte uploads, and an
// attachment whose bytes are not actually an image is a poor test of a pipeline
// that will one day sniff content types.
const PNG_1PX = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

// ── The fixtures ────────────────────────────────────────────────────────────

// Two titles agreeing for their first 80 characters after sanitising. This is
// the collision `collect.js` guards against by appending the Canvas id AFTER
// truncation; if that guard is ever removed these two become one folder and the
// manifest still validates, which is the whole danger.
const LONG_A =
  "Research Paper Draft on the Causes and Consequences of the Industrial Revolution Part One";
const LONG_B =
  "Research Paper Draft on the Causes and Consequences of the Industrial Revolution Part Two";

async function main() {
  console.log(`Canvas: ${CANVAS}`);
  const me = await api("/users/self");
  console.log(`Admin:  ${me.name} (id ${me.id})`);

  const student = await findOrCreateUser({
    login: STUDENT_LOGIN,
    name: STUDENT_NAME,
    password: STUDENT_PASSWORD,
  });
  console.log(`Student: ${student.name} (id ${student.id}) — ${STUDENT_LOGIN} / ${STUDENT_PASSWORD}`);

  // ── Course one: the text-heavy course ─────────────────────────────
  const english = await findOrCreateCourse("English 11");
  await enrol(english.id, student.id, "StudentEnrollment");
  console.log(`\nCourse: ${english.name} (id ${english.id})`);

  // Ordinary case: a file upload, graded, posted, with a teacher comment.
  const essay = await findOrCreateAssignment(english.id, {
    name: "Argument Essay",
    description: "<p>Write a 1,200-word argument essay. Use at least three sources.</p>",
    submissionTypes: ["online_upload"],
  });
  const essayFile = await uploadFile({
    name: "argument-essay.txt",
    contentType: "text/plain",
    bytes: enc(
      "The Case for Municipal Broadband\n\n" +
        "Access to the internet is no longer a convenience but an precondition for " +
        "participation in civic life. This essay argues that municipalities should " +
        "treat broadband as they treat water and roads.\n"
    ),
    as: student.id,
  });
  await submit(english.id, essay.id, student.id, {
    "submission[submission_type]": "online_upload",
    "submission[file_ids][]": essayFile.id,
  });
  await gradeAndComment(english.id, essay.id, student.id, {
    grade: 88,
    comment: "Strong thesis. Your second source is doing less work than you think — tighten paragraph four.",
  });
  console.log(`  ✓ ${essay.name} — uploaded, graded 88, commented`);

  // Rich text with an embedded image: the case where an image pasted into an
  // essay was fetched, packaged and silently discarded before the unclaimed-file
  // warning existed.
  const response = await findOrCreateAssignment(english.id, {
    name: "Reading Response",
    description: "<p>Respond to the assigned chapter in 300 words.</p>",
    submissionTypes: ["online_text_entry"],
  });
  const inlineImage = await uploadFile({
    name: "diagram.png",
    contentType: "image/png",
    bytes: PNG_1PX,
    as: student.id,
  });
  await submit(english.id, response.id, student.id, {
    "submission[submission_type]": "online_text_entry",
    "submission[body]":
      `<p>The chapter's argument rests on a distinction it never quite defends.</p>` +
      `<p><img src="${CANVAS}/files/${inlineImage.id}/preview" alt="diagram"></p>` +
      `<p>Still, the closing pages earn their conclusion.</p>`,
  });
  console.log(`  ✓ ${response.name} — text entry with embedded image ${inlineImage.id}`);

  // The truncation collision.
  for (const [title, body] of [
    [LONG_A, "Part one of the draft.\n"],
    [LONG_B, "Part two of the draft.\n"],
  ]) {
    const a = await findOrCreateAssignment(english.id, {
      name: title,
      submissionTypes: ["online_upload"],
    });
    const f = await uploadFile({
      name: "draft.txt",
      contentType: "text/plain",
      bytes: enc(body),
      as: student.id,
    });
    await submit(english.id, a.id, student.id, {
      "submission[submission_type]": "online_upload",
      "submission[file_ids][]": f.id,
    });
    console.log(`  ✓ ${title.slice(0, 50)}… (id ${a.id}) — collision fixture`);
  }

  // Instructions with no submission. Must not reach the manifest at all.
  const unsubmitted = await findOrCreateAssignment(english.id, {
    name: "Unsubmitted Reflection",
    description: "<p>A reflection the student never turned in.</p>",
    submissionTypes: ["online_upload"],
  });
  console.log(`  ✓ ${unsubmitted.name} — deliberately never submitted`);

  // ── Course two: proves courses[] is a list ────────────────────────
  const geometry = await findOrCreateCourse("Geometry");
  await enrol(geometry.id, student.id, "StudentEnrollment");
  console.log(`\nCourse: ${geometry.name} (id ${geometry.id})`);

  // Two attempts on one assignment — `submission_history` and the `attempt`
  // field the manifest carries per file.
  const proofs = await findOrCreateAssignment(geometry.id, {
    name: "Proof Set 1",
    description: "<p>Complete proofs 1 through 8.</p>",
    submissionTypes: ["online_upload"],
  });
  for (const [n, text] of [
    [1, "Proof 1: incomplete, stuck on the converse.\n"],
    [2, "Proof 1: corrected. The converse follows from the alternate interior angles.\n"],
  ]) {
    const f = await uploadFile({
      name: `proofs-attempt-${n}.txt`,
      contentType: "text/plain",
      bytes: enc(text),
      as: student.id,
    });
    // See `sleep` above: same-second submissions collapse into one history entry.
    if (n > 1) await sleep(1500);
    await submit(geometry.id, proofs.id, student.id, {
      "submission[submission_type]": "online_upload",
      "submission[file_ids][]": f.id,
    });
  }
  console.log(`  ✓ ${proofs.name} — two attempts`);

  // A teacher-attached file in the description: the linkedFiles harvest.
  //
  // Into the COURSE's files, not the admin's own. `/users/self/files` puts it
  // in the uploader's personal folder, where the enrolled student gets 403 on
  // the link — so the fixture would look correct, the export would warn that a
  // linked file could not be fetched, and `linkedFiles` would never actually be
  // exercised against a readable teacher attachment.
  const handout = await uploadFile({
    name: "constructions-handout.txt",
    contentType: "text/plain",
    bytes: enc("Constructions handout: compass and straightedge only.\n"),
    courseId: geometry.id,
  });
  const constructions = await findOrCreateAssignment(geometry.id, {
    name: "Constructions",
    description:
      `<p>Use the handout: ` +
      // Course-scoped, matching where the file now lives. A bare `/files/<id>`
      // link resolves for whoever owns the file and 403s for everyone else.
      `<a class="instructure_file_link" href="${CANVAS}/courses/${geometry.id}/files/${handout.id}/download">handout</a></p>`,
    submissionTypes: ["online_upload"],
  });
  const cf = await uploadFile({
    name: "constructions.txt",
    contentType: "text/plain",
    bytes: enc("Bisected the angle; see figure.\n"),
    as: student.id,
  });
  await submit(geometry.id, constructions.id, student.id, {
    "submission[submission_type]": "online_upload",
    "submission[file_ids][]": cf.id,
  });
  console.log(`  ✓ ${constructions.name} — teacher file ${handout.id} linked in description`);

  // ── Course three: the student is the TEACHER ──────────────────────
  //
  // Must be skipped before anything is fetched from it, with a warning that
  // says it was skipped on purpose rather than that it failed.
  const taught = await findOrCreateCourse("Peer Tutoring Seminar");
  await enrol(taught.id, student.id, "TeacherEnrollment");
  await findOrCreateAssignment(taught.id, {
    name: "Tutoring Log",
    description: "<p>Log your sessions.</p>",
    submissionTypes: ["online_text_entry"],
  });
  console.log(`\nCourse: ${taught.name} (id ${taught.id}) — student enrolled as TEACHER`);

  console.log(`
Done.

  Canvas   ${CANVAS}
  Student  ${STUDENT_LOGIN} / ${STUDENT_PASSWORD}
  Admin    admin@example.com / password

Sign in as the STUDENT, then run the export. Expect:
  - two courses in the manifest, not three
  - "Peer Tutoring Seminar" skipped with a not-a-student warning
  - "Unsubmitted Reflection" absent entirely
  - "Proof Set 1" carrying two attempts
  - the two Research Paper Draft folders distinct, each ending in its Canvas id
`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
