/**
 * Drive upstream's collector across every course and assemble one export.
 *
 * Original to this fork. This is the object `downloadCourse` receives as its
 * `ethyra` argument — the twenty `if (ethyra)` guards in that file all call back
 * into here.
 *
 * ── Why a recorder rather than a rewrite ──────────────────────────────
 *
 * `downloadCourse` already fetches everything this needs: descriptions,
 * rubrics, due dates, scores, `submission_history`, the teacher's comment
 * thread. Upstream only ever renders them to HTML for a person to read. So the
 * job is not to fetch any of it again — it is to be handed the same objects on
 * their way past and keep the structured values.
 *
 * That is why this is ~200 lines rather than the 1,500-line reimplementation it
 * would otherwise be, and it is why `git merge upstream/main` still works.
 *
 * ── Paths are read back, never predicted ──────────────────────────────
 *
 * `recordAssignment` runs mid-collection, but filenames are not final until the
 * end of `downloadCourse`: there is a Windows path-length truncation pass and a
 * collision pass that appends " (2)". So the manifest's file list is built from
 * the list the function RETURNS, matched to assignments by folder. Predicting
 * the names here instead would produce a manifest that disagrees with its own
 * archive — which the backend reports as files it cannot find, and drops.
 */

/** Trailing slash, because upstream composes paths as `path + filename`. */
function assignmentFolderFor(courseFolder, assignment) {
  return `${courseFolder}/${sanitizeFilename(assignment.name).substring(0, 80)}/`;
}

/**
 * The per-course recorder handed to `downloadCourse`.
 *
 * Deliberately dumb: it stores what it is given and computes nothing that the
 * collection pass could get wrong later.
 */
function createRecorder(course) {
  const courseFolder = sanitizeFilename(course.name).substring(0, 100);
  const assignments = new Map(); // folder → { assignment, submission }
  const warnings = [];

  return {
    courseFolder,
    assignments,
    warnings,

    /** Called by `downloadCourse` for both submissions and teacher attachments. */
    assignmentFolder(assignment) {
      return assignmentFolderFor(courseFolder, assignment);
    },

    recordAssignment(assignment) {
      const folder = assignmentFolderFor(courseFolder, assignment);
      const existing = assignments.get(folder);
      assignments.set(folder, { assignment, submission: existing?.submission || null });
    },

    recordSubmission(assignment, submission) {
      const folder = assignmentFolderFor(courseFolder, assignment);
      const existing = assignments.get(folder);
      assignments.set(folder, { assignment: existing?.assignment || assignment, submission });
    },

    warn(message) {
      warnings.push(`${course.name}: ${message}`);
    },
  };
}

/**
 * Collect every active course into one archive's worth of files and one manifest.
 *
 * ── There is nothing to choose ────────────────────────────────────────
 *
 * Every active enrolment, every time. No course picker, and the student is not
 * handed a zip to inspect first — Export means export.
 *
 * That is the same reasoning the backend's upload route already follows for a
 * hand-made export: the answer to "which coursework" is *all of it*, because the
 * profile is cumulative and a student is not in a position to know which
 * assignment will turn out to evidence which ACT standard. A picker would be a
 * question with no good answer, asked before anyone could answer it.
 *
 * Returns `{ manifest, files, warnings, totalBytes }`. `files` are upstream's
 * entries — `{ url, filename, path, size, role, attempt }` — ready to stream
 * into a single zip.
 */
async function collectExport({ origin, extensionVersion, onProgress = () => {} }) {
  const student = await fetchSelfUser(origin);
  const courses = await fetchAllCourses();
  if (!courses.length) throw new Error("No active courses found in this Canvas account.");
  const files = [];
  const manifestCourses = [];
  const warnings = [];

  for (const [index, course] of courses.entries()) {
    onProgress({ phase: "collecting", course: course.name, index, total: courses.length });

    const recorder = createRecorder(course);
    let courseFiles;
    try {
      courseFiles = await downloadCourse(
        course.id,
        course.name,
        origin,
        (msg) => onProgress({ phase: "collecting", course: course.name, index, total: courses.length, detail: msg }),
        recorder
      );
    } catch (err) {
      // One course failing must not lose the other five. The student is told
      // which one, rather than being handed a shorter export with no
      // explanation.
      console.error(`[Ethyra] Collecting ${course.name} failed:`, err);
      warnings.push(`${course.name} could not be collected: ${err?.message || err}`);
      continue;
    }

    warnings.push(...recorder.warnings);

    const manifestAssignments = [];
    for (const [folder, { assignment, submission }] of recorder.assignments) {
      // Read back, not predicted — see the module docstring.
      //
      // The per-file cap is applied HERE, while the manifest entry is being
      // built, so a dropped file leaves neither an archive entry nor a manifest
      // line. Dropping it afterwards would leave the manifest pointing at bytes
      // that were never uploaded, which the backend reports as a missing file.
      const own = courseFiles.filter((f) => f.path === folder && !oversized(f, warnings));
      const manifestFiles = own.map((f) => ({
        path: `${f.path}${f.filename}`,
        role: f.role || ROLE_SUBMISSION,
        ...(f.attempt != null ? { attempt: f.attempt } : {}),
      }));

      // Nothing of the student's here — an assignment with instructions they
      // never submitted to. Real, and not evidence about them: the backend would
      // enrol it in a run and spend an agent call to be told it is empty.
      if (!manifestFiles.some((f) => f.role === ROLE_SUBMISSION)) continue;

      manifestAssignments.push(
        manifestAssignment({
          assignment,
          submission,
          path: folder.replace(/\/$/, ""),
          files: manifestFiles,
        })
      );
    }

    if (!manifestAssignments.length) {
      warnings.push(`No submitted work found in ${course.name}.`);
      continue;
    }

    // Only the files that ended up in a recorded assignment. Upstream can emit
    // root-level extras; anything not claimed here would reach the backend as a
    // stray and be dropped, so it is dropped knowingly instead.
    const claimed = new Set(manifestAssignments.flatMap((a) => a.files.map((f) => f.path)));
    for (const f of courseFiles) {
      if (claimed.has(`${f.path}${f.filename}`)) files.push(f);
    }

    manifestCourses.push(
      manifestCourse({ course, path: recorder.courseFolder, assignments: manifestAssignments })
    );
  }

  const manifest = buildManifest({
    canvasHost: new URL(origin).host,
    extensionVersion,
    student,
    courses: manifestCourses,
    capturedAt: new Date().toISOString(),
  });

  // ── The safety net ────────────────────────────────────────────────
  //
  // The backend enforces all of this and fails the upload on a violation, which
  // is correct there and a miserable way to find out here — after a student has
  // waited out a twenty-minute export. A disagreement between the manifest and
  // the archive is a bug in this file, so it is loud rather than tolerated.
  const archivePaths = new Set(files.map((f) => `${f.path}${f.filename}`));
  archivePaths.add(MANIFEST_NAME);
  const problems = validateManifest(manifest, archivePaths);
  if (problems.length) {
    console.error("[Ethyra] Manifest does not match the archive:", problems);
    throw new Error(`Export is inconsistent and was not uploaded: ${problems[0]}`);
  }

  // The whole-archive cap does NOT trim. Silently dropping work to fit would
  // produce a learning graph missing assignments nobody was told about, and
  // "deselect a course" is a decision for the person whose coursework it is.
  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  if (totalBytes > ETHYRA_MAX_TOTAL_BYTES) {
    const mb = Math.round(totalBytes / (1024 * 1024));
    throw new Error(`This export is about ${mb} MB, over the 500 MB limit. Deselect a course and try again.`);
  }

  return { manifest, files, warnings, totalBytes };
}

/**
 * True when a file is over the backend's per-file cap, recording why.
 *
 * Dropped rather than fatal: one oversized video should not cost a student
 * their entire export, and the warning travels with the upload so the omission
 * is visible rather than silent.
 */
function oversized(file, warnings) {
  if ((file.size || 0) <= ETHYRA_MAX_FILE_BYTES) return false;
  warnings.push(`Skipped ${file.filename} — larger than the 50 MB per-file limit.`);
  return true;
}

/** The signed-in Canvas user. A personal export carries no name at all. */
async function fetchSelfUser(origin) {
  try {
    const res = await fetchWithRetry(`${origin}/api/v1/users/self`, {
      headers: { Accept: "application/json+canvas-string-ids" },
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
