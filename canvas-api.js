/**
 * Canvas Course Downloader — Canvas API Helpers
 *
 * Handles all communication with the Canvas REST API, including
 * pagination, retry logic, and timeout handling.
 */

const FETCH_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

/** Fetches with an AbortController timeout. */
function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

/** Fetches with retry and exponential backoff for transient errors. */
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options);
      // Ethyra fork: Canvas throttles a session that asks too fast with a 403
      // whose body says "Rate Limit Exceeded" — not a 429. Courses are read
      // side by side, so this is reachable; it is a wait, not a refusal.
      const throttled = res.status === 403 && (await isRateLimited(res));
      if (!throttled && (res.ok || (res.status < 500 && res.status !== 429))) return res;
      if (attempt === retries) return res;
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      console.warn(`[Canvas Downloader] ${res.status} on ${url}, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      console.warn(`[Canvas Downloader] Fetch error on ${url}, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** How long, and how far, the throttling check reads a 403's body. */
const RATE_LIMIT_READ_MS = 5000;
const RATE_LIMIT_READ_BYTES = 4096;

/**
 * True for Canvas's throttling 403, which says so in its body.
 *
 * Bounded in time and size. `fetchWithTimeout`'s deadline ends when the headers
 * arrive, so an unbounded read of a body that stalls would hang the course, and
 * with it the export. A read that runs out of either is cancelled and counts as
 * "not throttled", which is what the 403 meant before this check existed.
 */
async function isRateLimited(res) {
  const reader = res.clone().body?.getReader();
  if (!reader) return false;
  const timer = setTimeout(() => reader.cancel().catch(() => {}), RATE_LIMIT_READ_MS);
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < RATE_LIMIT_READ_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return /rate limit exceeded/i.test(text);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

/** Follows Canvas pagination links to collect all results. */
async function fetchAllPages(url) {
  const results = [];
  let next = url;

  while (next) {
    try {
      const res = await fetchWithRetry(next, {
        headers: { Accept: "application/json+canvas-string-ids" },
      });

      if (!res.ok) {
        console.warn(`[Canvas Downloader] ${res.status} ${res.statusText} — ${next}`);
        break;
      }

      results.push(...(await res.json()));

      next = parsePaginationLink(res.headers.get("link"));
    } catch (err) {
      if (err.name === "AbortError") {
        console.warn(`[Canvas Downloader] Request timed out: ${next}`);
      } else {
        console.error("[Canvas Downloader] API error:", err);
      }
      break;
    }
  }

  return results;
}

/** Returns courses for the current user. */
async function fetchAllCourses(enrollmentState = "active") {
  const domain = window.location.origin;
  const courses = await fetchAllPages(
    `${domain}/api/v1/courses?per_page=100&enrollment_state=${enrollmentState}&include[]=term`
  );
  return courses.filter((c) => c.name).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * True if the current user is a teacher/TA/designer in the course — i.e. has
 * access to the teacher-only endpoints (all submissions, full discussion
 * threads, every student's grades). Any failure resolves to `false` so the
 * caller falls back to plain student behavior.
 */
async function fetchCourseRole(domain, courseId) {
  try {
    const res = await fetchWithRetry(`${domain}/api/v1/courses/${courseId}?include[]=enrollments`, {
      headers: { Accept: "application/json+canvas-string-ids" },
    });
    if (!res.ok) return false;
    const course = await res.json();
    const teacherRoles = ["teacher", "ta", "designer"];
    return (course.enrollments || []).some((e) => teacherRoles.includes(e.type));
  } catch (err) {
    console.warn("[Canvas Downloader] Role detection failed, assuming student:", err);
    return false;
  }
}
