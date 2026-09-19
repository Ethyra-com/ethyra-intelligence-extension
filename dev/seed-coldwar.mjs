/**
 * Import the Cold War Seminar folder into the local Canvas as a real course.
 *
 * Run:  node dev/seed-coldwar.mjs [path-to-folder]
 * Default path: ~/Downloads/Cold_War_Seminar
 *
 * ── What this is, and why it is a better fixture than seed.mjs ────────
 *
 * `seed.mjs` builds edge cases: a name collision, a resubmission, an
 * unsubmitted assignment. Precise, synthetic, and every file in it is three
 * lines of prose I wrote.
 *
 * This builds the ordinary case at realistic scale, out of real `.docx` and
 * `.pdf` bytes with the filenames people actually produce —
 * `ColdWar_A03_105.docx`, `paper3_studentID106.pdf`,
 * `NoahLindqvist_ID114_paper3.docx`. Those names matter: the exporter
 * sanitises, truncates at 80 characters and de-collides them, and prose written
 * to be tidy never stresses that.
 *
 * ── Fifteen students, and only one of them is you ─────────────────────
 *
 * The whole class is loaded, not just the test account. That is the point.
 * Exporting as Ava Reyes with fourteen other students' papers sitting in the
 * same course is the only way to check the property `profile.js` is anxious
 * about — that a refactor aligning submission folders would start sweeping up
 * other students' work. Here, fourteen-fifteenths of the course must NOT appear
 * in the archive, and if it ever does, this catches it.
 *
 * The teacher's own handout for each assignment is attached to the assignment
 * description, so the `linkedFiles` harvest has real documents to find rather
 * than a synthetic stub.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { homedir } from "node:os";

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
  mapLimit,
} from "./canvas.mjs";

const ROOT = process.argv[2] || join(homedir(), "Downloads", "Cold_War_Seminar");
const COURSE_NAME = "Cold War History";

/** The student whose credentials get printed — the one you sign in as. */
const PRIMARY_ID = "101";

// ── CSV ─────────────────────────────────────────────────────────────────────

/**
 * A real parser rather than `split(",")`.
 *
 * Every assignment title in the key contains a comma — "The Origins of the
 * Cold War, 1945-1947" — so a naive split shifts every later column by one and
 * silently attaches the wrong score to the wrong paper. The failure is entirely
 * plausible-looking output, which is the worst kind.
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const contentTypeFor = (name) => CONTENT_TYPES[extname(name).toLowerCase()] || "application/octet-stream";

/** `Assignment_03_korean_war` → `3`. */
const numberFromDir = (dir) => String(Number((dir.match(/^Assignment_(\d+)/) || [])[1]));

async function main() {
  console.log(`Canvas: ${CANVAS}`);
  console.log(`Source: ${ROOT}\n`);

  const key = parseCSV(await readFile(join(ROOT, "_grading_key.csv"), "utf8"));
  if (!key.length) throw new Error("_grading_key.csv parsed to zero rows");

  // ── Locate every submission file on disk ──────────────────────────
  //
  // Matched to the key by filename, not by position or by parsing the student
  // id back out of the name. The names are deliberately inconsistent — that is
  // what they are for — and re-deriving the id from them here would be solving,
  // badly, the exact problem the key exists to have already solved.
  const dirs = (await readdir(ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith("Assignment_"))
    .map((d) => d.name);

  const onDisk = new Map(); // filename → absolute path
  for (const dir of dirs) {
    for (const f of await readdir(join(ROOT, dir))) {
      if (f.startsWith(".")) continue;
      onDisk.set(f, join(ROOT, dir, f));
    }
  }

  const missing = key.filter((r) => !onDisk.has(r.filename));
  if (missing.length) {
    console.warn(`  ! ${missing.length} row(s) in the key have no file on disk; skipping them`);
    for (const m of missing.slice(0, 5)) console.warn(`      ${m.filename}`);
  }
  const rows = key.filter((r) => onDisk.has(r.filename));

  // ── Students ──────────────────────────────────────────────────────
  const byId = new Map();
  for (const r of rows) if (!byId.has(r.student_id)) byId.set(r.student_id, r.student_name);

  const course = await findOrCreateCourse(COURSE_NAME);
  console.log(`Course: ${course.name} (id ${course.id})`);

  const students = new Map(); // student_id → canvas user
  for (const [sid, name] of [...byId].sort()) {
    const user = await findOrCreateUser({ login: `cw${sid}@example.com`, name });
    await enrol(course.id, user.id, "StudentEnrollment");
    students.set(sid, user);
  }
  console.log(`Students: ${students.size} enrolled\n`);

  // ── Assignments, each with the teacher's handout attached ─────────
  const instructionDir = join(ROOT, "00_Assignment_Instructions");
  const instructionFiles = await readdir(instructionDir).catch(() => []);

  const titles = new Map(); // assignment number → title
  for (const r of rows) titles.set(String(Number(r.assignment)), r.assignment_title);

  const assignments = new Map(); // assignment number → canvas assignment
  for (const [num, title] of [...titles].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const handoutName = instructionFiles.find((f) => numberFromDir(f) === num);

    let description = `<p>Seminar paper ${num}. Write a documented essay on the assigned topic.</p>`;
    if (handoutName) {
      // Into the COURSE's files, not the admin's own — see the note in
      // `uploadFile`. A handout in a personal folder 403s for every student.
      const handout = await uploadFile({
        name: handoutName,
        contentType: contentTypeFor(handoutName),
        bytes: await readFile(join(instructionDir, handoutName)),
        courseId: course.id,
      });
      description +=
        `<p>Instructions: ` +
        `<a class="instructure_file_link" href="${CANVAS}/courses/${course.id}/files/${handout.id}/download">` +
        `${basename(handoutName)}</a></p>`;
    }

    const a = await findOrCreateAssignment(course.id, { name: title, description, points: 100 });
    // An assignment found rather than created keeps whatever description it was
    // made with — including a link to a handout that has since been re-uploaded
    // somewhere readable. Re-running the seeder has to repair that, or the fix
    // only reaches a database created from scratch.
    if (a.description !== description) {
      await api(`/courses/${course.id}/assignments/${a.id}`, {
        method: "PUT",
        form: { "assignment[description]": description },
      });
    }
    assignments.set(num, a);
    console.log(`  ${String(num).padStart(2)} ${title}${handoutName ? "  + handout" : ""}`);
  }

  // ── Submissions ───────────────────────────────────────────────────
  console.log(`\nUploading ${rows.length} submissions…`);
  let done = 0;
  let failed = 0;

  await mapLimit(rows, 4, async (r) => {
    const student = students.get(r.student_id);
    const assignment = assignments.get(String(Number(r.assignment)));
    if (!student || !assignment) return;

    try {
      const file = await uploadFile({
        name: r.filename,
        contentType: contentTypeFor(r.filename),
        bytes: await readFile(onDisk.get(r.filename)),
        as: student.id,
      });
      await submit(course.id, assignment.id, student.id, {
        "submission[submission_type]": "online_upload",
        "submission[file_ids][]": file.id,
      });
      // The key's intended_score is the teacher's mark. Posted, so the student
      // can see it — an unposted grade is absent from a student's API view,
      // which is the open question in the root README.
      await gradeAndComment(course.id, assignment.id, student.id, {
        grade: Number(r.intended_score),
      });
    } catch (err) {
      failed++;
      console.warn(`  ! ${r.filename}: ${err.message.split("\n")[0]}`);
      return;
    }

    if (++done % 25 === 0) console.log(`  …${done}/${rows.length}`);
  });

  const primary = students.get(PRIMARY_ID);
  console.log(`
Done — ${done} submitted${failed ? `, ${failed} failed` : ""}.

  Canvas   ${CANVAS}
  Sign in  cw${PRIMARY_ID}@example.com / password123   (${primary?.name})

Exporting as that account should produce, for ${COURSE_NAME}:
  - ${titles.size} assignments, each with a score and the teacher's handout
  - exactly ${rows.filter((r) => r.student_id === PRIMARY_ID).length} submitted files — one per assignment
  - NOTHING belonging to the other ${students.size - 1} students in the course
`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
