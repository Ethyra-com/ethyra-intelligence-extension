/**
 * Import the Cold War Seminar folder into the local Canvas as a real course.
 *
 * Run:  node dev/seed-coldwar.mjs [path-to-folder] [path-to-english-folder]
 * Default paths: ~/Downloads/Cold_War_Seminar, ~/Downloads/student_submissions/english
 *
 * Also gives the primary student (cw101, Ava Reyes) a second class, English 10,
 * from the English essays — see `seedEnglish`. To add only that to a Canvas
 * already seeded with the Cold War course:  ENGLISH_ONLY=1 node dev/seed-coldwar.mjs
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

// ── The same student's second class ─────────────────────────────────────────
//
// A class window is per course, so the demo needs more than one. English is the
// primary student's alone — ten essays, no classmates — dated and graded, with
// one gradebook item nothing was turned in for. The essays' own headers name a
// different student; nothing reads them for identity.
const ENGLISH_ROOT = process.argv[3] || join(homedir(), "Downloads", "student_submissions", "english");
const ENGLISH_COURSE = { name: "English 10", code: "ENG-10" };
const ENGLISH_ESSAYS = [
  ["English_Essay_01.pdf", "The Green Light: Hope and Illusion in The Great Gatsby", "2026-09-08", 88],
  ["English_Essay_02.pdf", "Courage in To Kill a Mockingbird", "2026-09-11", 85],
  ["English_Essay_03.pdf", "Loneliness in Of Mice and Men", "2026-09-14", 90],
  ["English_Essay_04.pdf", "Ambition and Guilt in Macbeth", "2026-09-17", 83],
  ["English_Essay_05.pdf", "Civilization and Savagery in Lord of the Flies", "2026-09-20", 91],
  ["English_Essay_06.pdf", "Who Is to Blame in Romeo and Juliet?", "2026-09-23", 87],
  ["English_Essay_07.pdf", "Mass Hysteria in The Crucible", "2026-09-26", 92],
  ["English_Essay_08.pdf", "Censorship and Technology in Fahrenheit 451", "2026-09-29", 89],
  ["English_Essay_09.pdf", "Personal Narrative: The Summer I Learned to Fail", "2026-10-02", 94],
  ["English_Essay_10.pdf", "The Hero's Journey in The Odyssey", "2026-10-05", 93],
];

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

  // English alone, onto a Canvas that already holds the Cold War course. The
  // Cold War half is not idempotent for submissions — a re-run makes every
  // paper a second attempt — so adding English must not re-run it.
  if (process.env.ENGLISH_ONLY === "1") {
    const primary = await findOrCreateUser({ login: `cw${PRIMARY_ID}@example.com`, name: "Ava Reyes" });
    await seedEnglish(primary);
    console.log(`\nDone. Sign in as cw${PRIMARY_ID}@example.com / password123.`);
    return;
  }

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
  if (primary) await seedEnglish(primary);

  console.log(`
Done — ${done} submitted${failed ? `, ${failed} failed` : ""}.

  Canvas   ${CANVAS}
  Sign in  cw${PRIMARY_ID}@example.com / password123   (${primary?.name})

Exporting as that account should produce, for ${COURSE_NAME}:
  - ${titles.size} assignments, each with a score and the teacher's handout
  - exactly ${rows.filter((r) => r.student_id === PRIMARY_ID).length} submitted files — one per assignment
  - NOTHING belonging to the other ${students.size - 1} students in the course
and for ${ENGLISH_COURSE.name}:
  - ${ENGLISH_ESSAYS.length} graded essays, and one participation grade with no files
`);
}

/**
 * English, for the primary student only. Idempotent: an essay already
 * submitted is not submitted again, which would make it a second attempt.
 */
async function seedEnglish(student) {
  const course = await findOrCreateCourse(ENGLISH_COURSE.name);
  await api(`/courses/${course.id}`, { method: "PUT", form: { "course[course_code]": ENGLISH_COURSE.code } });
  await enrol(course.id, student.id, "StudentEnrollment");
  console.log(`\nCourse: ${course.name} (id ${course.id}) — ${student.name} only`);

  for (const [file, title, due, score] of ENGLISH_ESSAYS) {
    const a = await findOrCreateAssignment(course.id, {
      name: title,
      description: `<p>Write a literary analysis essay: ${title}. 500–700 words, MLA format.</p>`,
      points: 100,
      dueAt: `${due}T23:59:00Z`,
    });
    const existing = await api(`/courses/${course.id}/assignments/${a.id}/submissions/${student.id}`);
    if (!existing?.submitted_at) {
      const uploaded = await uploadFile({
        name: file,
        contentType: contentTypeFor(file),
        bytes: await readFile(join(ENGLISH_ROOT, file)),
        as: student.id,
      });
      await submit(course.id, a.id, student.id, {
        "submission[submission_type]": "online_upload",
        "submission[file_ids][]": uploaded.id,
      });
    }
    await gradeAndComment(course.id, a.id, student.id, { grade: score });
    console.log(`  ✓ ${title} — ${score} / 100`);
  }

  // Graded, nothing turned in: the class window lists it as "No writing to read."
  const participation = await findOrCreateAssignment(course.id, {
    name: "Class Participation",
    submissionTypes: ["none"],
    points: 20,
    dueAt: "2026-09-30T23:59:00Z",
  });
  await gradeAndComment(course.id, participation.id, student.id, { grade: 18 });
  console.log(`  ✓ Class Participation — 18 / 20, nothing turned in`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
