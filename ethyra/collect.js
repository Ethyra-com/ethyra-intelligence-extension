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

// ── Folder names carry the Canvas id, and must ───────────────────────────────
//
// A folder is an IDENTITY here, not a label. It keys the recorder's map of
// assignments and it is what `collectExport` matches files against, so two
// things sharing one folder become one thing.
//
// Names collide three ways, all of them real:
//
//   exact       one course can hold two assignments called "Weekly Reflection"
//   sanitised   "Essay: Part 1" and "Essay- Part 1" both become "Essay- Part 1"
//   truncated   two paper titles sharing their first 80 characters — the
//               likeliest of the three, because long assignment names are
//               common and their distinguishing word tends to be at the end
//
// The damage is quiet. The recorder's map keeps whichever assignment was
// recorded last, while `downloadCourse` has already queued BOTH assignments'
// files under that one folder — so the survivor claims all of them and the work
// gets measured against the wrong handout. The resulting manifest passes
// `validateManifest` cleanly: every file exists, every file is claimed, there is
// submitted work. Nothing downstream can tell it apart from a correct export.
//
// The id goes AFTER truncation, or the thing making the name unique is the
// first thing cut off.

/** A course's folder: sanitised name, then its Canvas id. One path component. */
function courseFolderFor(course) {
  return `${sanitizeFilename(course.name).substring(0, 100)}-${canvasId(course.id)}`;
}

/** Trailing slash, because upstream composes paths as `path + filename`. */
function assignmentFolderFor(courseFolder, assignment) {
  return `${courseFolder}/${sanitizeFilename(assignment.name).substring(0, 80)}-${canvasId(assignment.id)}/`;
}

/**
 * A Canvas id, safe to put in a path.
 *
 * Canvas sends these as numbers, or as strings under the
 * `application/json+canvas-string-ids` Accept header this extension uses. The
 * filter is belt and braces — an id is the one part of the folder that has to
 * survive intact, so it is not left to `sanitizeFilename`, which would silently
 * turn an unexpected character into a dash and reintroduce the collision.
 */
function canvasId(value) {
  const cleaned = String(value ?? "").replace(/[^\w-]/g, "");
  return cleaned || "unknown";
}

/**
 * The per-course recorder handed to `downloadCourse`.
 *
 * Deliberately dumb: it stores what it is given and computes nothing that the
 * collection pass could get wrong later.
 */
function createRecorder(course) {
  const courseFolder = courseFolderFor(course);
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
      // A course the student teaches or assists in is skipped on purpose, and
      // saying "could not be collected" about a deliberate choice is the kind of
      // wrong that makes someone retry, or write in about a bug that is not one.
      if (err?.code === ETHYRA_NOT_A_STUDENT) {
        console.info(`[Ethyra] Skipping ${course.name}: not a student enrolment.`);
        warnings.push(`${course.name} was skipped — ${err.message}`);
        continue;
      }
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

    // ── Only the files an assignment claimed, and say what was not ────
    //
    // Upstream emits root-level extras that no assignment owns, and anything
    // unclaimed would reach the backend as a stray and be dropped there anyway.
    //
    // This used to drop them in silence, and the comment called that "dropped
    // knowingly" — which was true of the author and nobody else. It hid a real
    // bug: files embedded in a student's rich-text submission were queued into
    // `Extracted_Files/` with no role, claimed by nothing, and vanished. An
    // image pasted into an essay was fetched, packaged and discarded without a
    // trace. The warning is what would have made that visible on the first run.
    const claimed = new Set(manifestAssignments.flatMap((a) => a.files.map((f) => f.path)));
    const unclaimed = [];
    for (const f of courseFiles) {
      const path = `${f.path}${f.filename}`;
      if (claimed.has(path)) files.push(f);
      else unclaimed.push(path);
    }
    if (unclaimed.length) {
      console.warn(`[Ethyra] ${course.name}: not uploading ${unclaimed.length} unclaimed file(s)`, unclaimed);
      warnings.push(
        `${unclaimed.length} file(s) in ${course.name} were not attached to an assignment and were left out: ` +
          unclaimed.slice(0, 5).join(", ")
      );
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
  // choosing what to leave out is not a decision this code gets to make.
  //
  // The message says the size and stops there, on purpose. This export has no
  // course picker — every active enrolment goes, every time — so there is
  // nothing a student can do about the total. Telling them to try again, or to
  // remove something, would be an instruction they cannot follow, which is
  // worse than admitting the limit is ours to raise.
  const totalBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
  if (totalBytes > ETHYRA_MAX_TOTAL_BYTES) {
    const mb = Math.round(totalBytes / (1024 * 1024));
    const limit = Math.round(ETHYRA_MAX_TOTAL_BYTES / (1024 * 1024));
    throw new Error(
      `Your coursework comes to about ${mb} MB, over Ethyra's ${limit} MB limit, so nothing was uploaded. ` +
        "This is a limit on our side rather than anything you can change — please let Ethyra know."
    );
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
