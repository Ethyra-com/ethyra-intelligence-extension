/**
 * A course's structure and text: syllabus, modules, pages, quizzes, outcomes,
 * and its document files.
 *
 * Original to this fork. Added 2026-10-13, when the product decided the
 * extension collects the course itself as well as the student's work, so the
 * backend can build a per-course learning map and know what comes next in a
 * class. It travels as `structure` on each course of `ethyra-manifest.json`.
 *
 * ── Why not upstream's mirror ─────────────────────────────────────────
 *
 * `downloadCourse` can already fetch pages, modules, files and the syllabus,
 * behind the content types `profile.js` turns off. It renders them to HTML or
 * CSV files at the course root — files no assignment claims, which the backend
 * would drop with a warning. What is wanted here is DATA in the manifest, so
 * this reads the same Canvas endpoints itself and keeps the structured values.
 * `ETHYRA_CONTENT_TYPES` stays as it is.
 *
 * ── Never the reason an export fails ──────────────────────────────────
 *
 * Students routinely cannot see the Files or Pages tab, and a course may have no
 * outcomes or no syllabus. Every section is fetched on its own and any failure —
 * a 401/403/404, a timeout, a malformed answer — leaves that one key out.
 * Absent means "could not look"; an empty list means "looked, found none".
 *
 * ── What it never reads ───────────────────────────────────────────────
 *
 * Quiz questions and answers (the quiz LIST carries none), video, audio or other
 * media, other students' anything, and discussions and announcements.
 *
 * ── Course files ──────────────────────────────────────────────────────
 *
 * Document types only, not already in the export as part of an assignment, and
 * sent ONLY by the per-file upload (hash, ask which are new, PUT those). The
 * one-zip fallback leaves them and `structure.files` out entirely: an archive
 * entry no assignment claims is reported by the backend as unclaimed.
 */

const STRUCTURE_MAX_PAGES = 200;
const STRUCTURE_MAX_FILES = 300;
const STRUCTURE_BODY_CHARS = 64_000;
const STRUCTURE_OUTCOME_CHARS = 2_000;
/** Page bodies fetched at once within one course. Courses already run three wide. */
const STRUCTURE_PAGE_CONCURRENCY = 3;

const STRUCTURE_DOC_EXTENSIONS = new Set([
  "pdf", "docx", "doc", "pptx", "xlsx", "txt", "rtf", "odt", "md", "html", "htm",
]);
const STRUCTURE_DOC_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "application/rtf",
  "text/rtf",
  "application/vnd.oasis.opendocument.text",
  "text/markdown",
  "text/x-markdown",
  "text/html",
]);

const STRUCTURE_HEADERS = { headers: { Accept: "application/json+canvas-string-ids" } };

/** One Canvas object, or null on any failure. */
async function fetchStructureJson(url) {
  try {
    const res = await fetchWithRetry(url, STRUCTURE_HEADERS);
    if (!res.ok) {
      console.info(`[Ethyra] Course structure: ${res.status} on ${url}, left out.`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.info(`[Ethyra] Course structure: ${url} failed, left out:`, err?.message || err);
    return null;
  }
}

/**
 * Every page of a Canvas list, or null when any page of it fails.
 *
 * Not upstream's `fetchAllPages`, which answers a 403 with an empty list — and
 * "could not look" must not read as "there are none". `keep` filters as it
 * goes and `max` stops paginating once that many are kept, so a course with
 * 2,000 files is not listed to the end to find the first 300 documents.
 */
async function fetchStructureList(url, { max = Infinity, keep = () => true } = {}) {
  const out = [];
  let next = url;
  while (next && out.length < max) {
    try {
      const res = await fetchWithRetry(next, STRUCTURE_HEADERS);
      if (!res.ok) {
        console.info(`[Ethyra] Course structure: ${res.status} on ${next}, left out.`);
        return null;
      }
      const page = await res.json();
      if (!Array.isArray(page)) return null;
      for (const item of page) {
        if (out.length >= max) break;
        if (item && keep(item)) out.push(item);
      }
      next = parsePaginationLink(res.headers.get("link"));
    } catch (err) {
      console.info(`[Ethyra] Course structure: ${next} failed, left out:`, err?.message || err);
      return null;
    }
  }
  return out;
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function structureMapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Shaping: Canvas objects → contract objects. Pure. ────────────────────────

function structureModule(module, items) {
  return {
    name: text(module.name, 512),
    position: number(module.position),
    items: (items || []).map((item) => ({
      // Locked and future items are listed with their titles: that is how the
      // backend learns what comes next.
      title: text(item.title, 512),
      type: text(item.type, 64),
      position: number(item.position),
      indent: number(item.indent),
      due_at: timestamp(item.content_details?.due_at),
    })),
  };
}

function structurePage(page, body) {
  return {
    title: text(page.title, 512),
    url: text(page.url, 512),
    body_html: text(body, STRUCTURE_BODY_CHARS),
    updated_at: timestamp(page.updated_at),
  };
}

function structureQuiz(quiz) {
  // Metadata only. The quiz list carries no questions, and none are asked for.
  return {
    title: text(quiz.title, 512),
    description_html: text(quiz.description, STRUCTURE_BODY_CHARS),
    due_at: timestamp(quiz.due_at),
    question_count: number(quiz.question_count),
  };
}

function structureOutcome(link) {
  const outcome = link?.outcome;
  const title = text(outcome?.title, 512);
  if (!title) return null;
  return { title, description: text(outcome.description, STRUCTURE_OUTCOME_CHARS) };
}

/** True for a course file worth sending: a readable document within the per-file cap. */
function isCourseDocument(file) {
  if (!file || !file.url || file.locked_for_user || file.hidden_for_user) return false;
  const size = file.size || 0;
  if (size <= 0 || size > ETHYRA_MAX_FILE_BYTES) return false;
  const name = String(file.display_name || file.filename || "");
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  const type = String(file["content-type"] || "").split(";")[0].trim().toLowerCase();
  // Never media, whatever Canvas says its type is.
  if (/^(video|audio|image)\//.test(type)) return false;
  if (!STRUCTURE_DOC_EXTENSIONS.has(ext) && ETHYRA_UNREADABLE_EXTENSIONS.has(ext)) return false;
  return STRUCTURE_DOC_EXTENSIONS.has(ext) || STRUCTURE_DOC_CONTENT_TYPES.has(type);
}

// ── Fetching ──────────────────────────────────────────────────────────────────

async function fetchSyllabus(api) {
  const course = await fetchStructureJson(api("?include[]=syllabus_body"));
  if (!course || typeof course !== "object") return undefined;
  return text(course.syllabus_body, STRUCTURE_BODY_CHARS);
}

async function fetchModules(api) {
  // `content_details` is what carries an item's due date.
  const modules = await fetchStructureList(api("/modules?include[]=items&include[]=content_details&per_page=100"));
  if (!modules) return undefined;
  const out = [];
  for (const module of modules) {
    let items = module.items;
    // Canvas leaves `items` out of a module with too many to inline, and points
    // at them instead. A module whose items cannot be read keeps its name.
    if (!Array.isArray(items) && module.items_url) {
      const sep = module.items_url.includes("?") ? "&" : "?";
      items = await fetchStructureList(`${module.items_url}${sep}include[]=content_details&per_page=100`);
    }
    out.push(structureModule(module, items));
  }
  return out;
}

async function fetchPages(api) {
  const pages = await fetchStructureList(api("/pages?per_page=100&published=true"), { max: STRUCTURE_MAX_PAGES });
  if (!pages) return undefined;
  return structureMapLimit(pages, STRUCTURE_PAGE_CONCURRENCY, async (page) => {
    // A page the student cannot open keeps its title, with no body.
    const detail = page.url ? await fetchStructureJson(api(`/pages/${encodeURIComponent(page.url)}`)) : null;
    return structurePage(page, detail?.body);
  });
}

async function fetchQuizzes(api) {
  const quizzes = await fetchStructureList(api("/quizzes?per_page=100"));
  return quizzes ? quizzes.map(structureQuiz) : undefined;
}

async function fetchOutcomes(api) {
  const links = await fetchStructureList(api("/outcome_group_links?per_page=100"));
  return links ? links.map(structureOutcome).filter(Boolean) : undefined;
}

/** Canvas's file objects for the documents to send, or undefined when the list cannot be read. */
async function fetchCourseDocuments(api, claimedIds) {
  const files = await fetchStructureList(api("/files?per_page=100"), {
    max: STRUCTURE_MAX_FILES,
    keep: (f) => isCourseDocument(f) && !claimedIds.has(String(f.id)),
  });
  return files || undefined;
}

/**
 * One course's structure, without `files`, and the course documents to send.
 *
 * `claimedIds` are the Canvas ids of files already in the export through an
 * assignment, which are not listed twice. `withFiles` false skips the file
 * listing entirely — the one-zip fallback, which never carries them.
 *
 * Returns `{ structure, documents }`. `documents` is null when the file list
 * could not be read (or was not asked for), so `structure.files` stays absent.
 */
async function fetchCourseStructure({ origin, courseId, claimedIds = new Set(), withFiles = true }) {
  const api = (rest) => `${origin}/api/v1/courses/${courseId}${rest}`;
  const [syllabus, modules, pages, quizzes, outcomes, documents] = await Promise.all([
    fetchSyllabus(api),
    fetchModules(api),
    fetchPages(api),
    fetchQuizzes(api),
    fetchOutcomes(api),
    withFiles ? fetchCourseDocuments(api, claimedIds) : undefined,
  ]);
  const structure = {};
  if (syllabus !== undefined) structure.syllabus_html = syllabus;
  if (modules !== undefined) structure.modules = modules;
  if (pages !== undefined) structure.pages = pages;
  if (quizzes !== undefined) structure.quizzes = quizzes;
  if (outcomes !== undefined) structure.outcomes = outcomes;
  return { structure, documents: documents ?? null };
}

/**
 * Course documents as the file sender's entries, one folder each so two files
 * with the same name cannot share a key. The path is only a key: these never
 * enter the archive or the manifest's assignment paths.
 */
function courseDocumentEntries(courseFolder, documents) {
  return documents.map((f) => ({
    url: f.url,
    filename: sanitizeFilename(f.display_name || f.filename || `file_${f.id}`),
    path: `${courseFolder}/.course-files/${String(f.id).replace(/[^\w-]/g, "")}/`,
    size: f.size || 0,
    canvasId: String(f.id),
    display_name: text(f.display_name || f.filename, 512),
    content_type: text(f["content-type"], 255),
  }));
}

/**
 * `structure.files` from what the sender stored. A file that failed, or that is
 * byte-for-byte one of this course's submitted files, is left out.
 */
function structureFiles(entries, hashes, failed = [], exclude = new Set()) {
  const gone = new Set(failed);
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = `${entry.path}${entry.filename}`;
    const stored = hashes.get(key);
    if (!stored || gone.has(key) || exclude.has(stored.sha256) || seen.has(stored.sha256)) continue;
    seen.add(stored.sha256);
    out.push({
      sha256: stored.sha256,
      size: stored.size,
      display_name: entry.display_name,
      content_type: entry.content_type,
    });
  }
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    STRUCTURE_MAX_FILES,
    STRUCTURE_MAX_PAGES,
    courseDocumentEntries,
    fetchCourseStructure,
    isCourseDocument,
    structureFiles,
  };
}
