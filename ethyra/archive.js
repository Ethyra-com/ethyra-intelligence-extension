/**
 * One zip, every course, streamed.
 *
 * Original to this fork, though the streaming shape is upstream's — see
 * `downloadAsZip` in `downloader.js`, which is the same idea pointed at
 * `chrome.downloads` instead of an upload.
 *
 * ── Why one archive and not one per course ────────────────────────────
 *
 * Upstream produces a zip per course because it writes to a Downloads folder,
 * where separate archives are kinder. Nothing about that reasoning survives the
 * change of destination, and on the Ethyra side the difference is not cosmetic:
 *
 * An upload is a **snapshot in a series**. `CanvasUpload.sequence` increments
 * per upload and the profile's trend is measured along that axis, so six
 * courses arriving as six uploads would read as six months of progress. It
 * would also start six analysis runs, write six narratives, and consume six
 * units of a monthly quota whose free tier is two.
 *
 * So: one archive, one upload, one snapshot.
 *
 * ── Streaming, not buffering ──────────────────────────────────────────
 *
 * `client-zip` pulls from the generator lazily — each yield happens after the
 * previous file's body has finished streaming into the archive. Peak memory is
 * one network chunk plus the final Blob, rather than every input file plus the
 * whole output at once.
 */

/**
 * Build the archive.
 *
 * `files` are upstream's entries — `{ url, filename, path, size }`. `manifest`
 * is written in at the root as `ethyra-manifest.json`; the backend finds it
 * there and switches from inferring structure to reading it.
 *
 * Returns `{ blob, failed }`. A file that cannot be fetched is reported, not
 * fatal — Canvas attachment URLs carry time-limited verifiers and one expiring
 * mid-export should cost that file, not the other two hundred.
 */
async function buildArchive(files, manifest, { signal, onProgress = () => {} } = {}) {
  const total = files.length + 1;
  const failed = [];
  let completed = 0;

  async function* source() {
    // ── The manifest is written LAST, and that is load-bearing ────────
    //
    // It has to describe the archive it is in, and which files made it cannot
    // be known until they have all been tried: a Canvas attachment URL carries
    // a time-limited verifier, and one expiring mid-export is ordinary. Writing
    // the manifest first and pruning afterwards would prune a copy — the
    // archive would already hold the version naming files it does not contain,
    // which the backend reads as an assignment that silently lost a submission.
    //
    // Zip entry order is free, and the backend finds the manifest by name
    // wherever it sits.
    for (const file of files) {
      if (signal?.aborted) return;
      const name = `${file.path}${file.filename}`;
      onProgress({ phase: "archiving", completed, total, current: file.filename });

      try {
        let input;
        if (file.url.startsWith("data:")) {
          // Canvas's inline rich-text submissions, encoded by the collector.
          input = new Uint8Array(await (await fetch(file.url)).arrayBuffer());
        } else {
          const res = await fetch(file.url, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          input = res.body;
        }
        completed++;
        yield { name, input, lastModified: new Date(), ...(file.size ? { size: file.size } : {}) };
      } catch (err) {
        if (err?.name === "AbortError") return;
        console.warn(`[Ethyra] Could not fetch ${name}:`, err);
        failed.push(name);
      }
    }

    if (signal?.aborted) return;
    yield {
      name: MANIFEST_NAME,
      input: new TextEncoder().encode(JSON.stringify(pruneFailed(manifest, failed), null, 2)),
      lastModified: new Date(manifest.captured_at),
    };
    completed++;
  }

  const response = downloadZip(source(), { buffersAreUTF8: true });
  const blob = await response.blob();
  onProgress({ phase: "archiving", completed, total, current: null });
  return { blob, failed };
}

/**
 * Drop from the manifest any file the archive failed to fetch.
 *
 * The alternative is a manifest naming bytes that are not there, which the
 * backend reports as missing files and drops — producing an assignment that
 * silently lost a submission. Better to state exactly what was uploaded.
 *
 * An assignment whose submitted work all failed is removed outright, and a
 * course left with no submitted work after that goes too: both would cost an
 * agent call to be told there is nothing in them.
 *
 * A gradebook row listed with no files from the start is kept. Nothing of it
 * failed — it never had files — and it is how the class window shows an item
 * graded without a submission. `collect.js` already dropped a course of only
 * such rows, and the course rule here is the same one.
 */
function pruneFailed(manifest, failed) {
  if (!failed.length) return manifest;
  const gone = new Set(failed);

  for (const course of manifest.courses) {
    const gradebookRows = new Set(course.assignments.filter((a) => a.files.length === 0));
    for (const assignment of course.assignments) {
      assignment.files = assignment.files.filter((f) => !gone.has(f.path));
    }
    course.assignments = course.assignments.filter(
      (a) => gradebookRows.has(a) || a.files.some((f) => f.role === ROLE_SUBMISSION)
    );
  }
  manifest.courses = manifest.courses.filter((c) => c.assignments.some((a) => a.files.length));
  return manifest;
}
