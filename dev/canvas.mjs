/**
 * A thin Canvas API client for the seed scripts.
 *
 * Shared by `seed.mjs` (synthetic edge-case fixtures) and `seed-coldwar.mjs`
 * (a real course imported from disk). One implementation, because the two
 * scripts must agree about ids, headers and the upload dance — and a second
 * copy is how they would quietly stop agreeing.
 */

export const CANVAS = process.env.CANVAS_URL || "http://localhost:9100";

export const TOKEN =
  process.env.CANVAS_TOKEN ||
  "YPhZLv6wyABWUeEKMz99VGQvwNmETtZ8eerYHf4Afzv6uR8m4kAWnvD2wBCKkAF7";

export const ACCOUNT = 1;

/**
 * Canvas string ids, always.
 *
 * The extension sends this Accept header, so ids come back as strings there.
 * Seeding under the same header means the ids these scripts print are the ids
 * the export will carry.
 */
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/json+canvas-string-ids",
};

export async function api(path, { method = "GET", form, as } = {}) {
  const url = new URL(path.startsWith("http") ? path : `${CANVAS}/api/v1${path}`);
  if (as) url.searchParams.set("as_user_id", as);

  const init = { method, headers: { ...HEADERS } };
  if (form) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (Array.isArray(v)) v.forEach((item) => body.append(k, item));
      else if (v != null) body.append(k, String(v));
    }
    init.body = body;
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url.pathname} → ${res.status}\n${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/**
 * Canvas never accepts file bytes on the resource endpoint. You ask for a slot,
 * POST the bytes wherever it points, and the response to THAT is the file. The
 * middle step carries its own signature in `upload_params`, so our bearer token
 * must not be sent along with it.
 */
export async function uploadFile({ name, contentType, bytes, as, courseId }) {
  // ── Where a file lives decides who may read it ──────────────────────
  //
  // `/users/self/files` puts it in that user's PERSONAL files. For a student's
  // submission that is right and is what Canvas itself does. For a teacher's
  // handout it is quietly wrong: the file is readable only by the uploader, so
  // every enrolled student gets 403 on the link in the assignment description,
  // and the export collects the assignment with none of its instructions.
  //
  // The symptom is a 403 on `/api/v1/files/<id>` and nothing else — the
  // assignment, its description and the link all look correct.
  //
  // `courseId` puts it in the course's files instead, which is where a teacher
  // attaching a handout actually puts it, and which every enrolled student can
  // read.
  const target = courseId ? `/courses/${courseId}/files` : `/users/self/files`;
  const slot = await api(target, {
    method: "POST",
    as,
    form: {
      name,
      size: bytes.byteLength,
      content_type: contentType,
      parent_folder_path: courseId ? "/course files/handouts" : "/my files/submissions",
      on_duplicate: "overwrite",
    },
  });

  const form = new FormData();
  for (const [k, v] of Object.entries(slot.upload_params || {})) form.append(k, v);
  form.append("file", new Blob([bytes], { type: contentType }), name);

  const res = await fetch(slot.upload_url, { method: "POST", body: form, redirect: "follow" });
  if (!res.ok) throw new Error(`upload POST → ${res.status} ${await res.text()}`);

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`upload returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export async function findOrCreateUser({ login, name, password = "password123" }) {
  const found = await api(
    `/accounts/${ACCOUNT}/users?search_term=${encodeURIComponent(login)}&per_page=50`
  );
  const hit = found.find((u) => u.login_id === login);
  if (hit) return hit;
  return api(`/accounts/${ACCOUNT}/users`, {
    method: "POST",
    form: {
      "user[name]": name,
      "user[terms_of_use]": true,
      "user[skip_registration]": true,
      "pseudonym[unique_id]": login,
      "pseudonym[password]": password,
      "pseudonym[send_confirmation]": false,
    },
  });
}

export async function findOrCreateCourse(name) {
  const all = await api(
    `/accounts/${ACCOUNT}/courses?per_page=100&search_term=${encodeURIComponent(name)}`
  );
  const hit = all.find((c) => c.name === name);
  if (hit) return hit;
  const course = await api(`/accounts/${ACCOUNT}/courses`, {
    method: "POST",
    form: { "course[name]": name, "course[course_code]": name.slice(0, 12), offer: true },
  });
  // `offer: true` on create is honoured inconsistently across releases, and an
  // unpublished course is invisible to the student — which looks exactly like
  // the exporter finding nothing.
  await api(`/courses/${course.id}`, { method: "PUT", form: { "course[event]": "offer" } });
  return course;
}

export async function enrol(courseId, userId, type) {
  const existing = await api(`/courses/${courseId}/enrollments?user_id=${userId}&per_page=100`);
  const hit = existing.find((e) => e.type === type);
  if (hit) return hit;
  return api(`/courses/${courseId}/enrollments`, {
    method: "POST",
    form: {
      "enrollment[user_id]": userId,
      "enrollment[type]": type,
      "enrollment[enrollment_state]": "active",
      "enrollment[notify]": false,
    },
  });
}

export async function findOrCreateAssignment(courseId, spec) {
  const all = await api(`/courses/${courseId}/assignments?per_page=100`);
  const hit = all.find((a) => a.name === spec.name);
  if (hit) return hit;
  return api(`/courses/${courseId}/assignments`, {
    method: "POST",
    form: {
      "assignment[name]": spec.name,
      "assignment[description]": spec.description || "",
      "assignment[submission_types][]": spec.submissionTypes || ["online_upload"],
      "assignment[points_possible]": spec.points ?? 100,
      "assignment[due_at]": spec.dueAt,
      "assignment[published]": true,
    },
  });
}

export async function submit(courseId, assignmentId, studentId, payload) {
  return api(`/courses/${courseId}/assignments/${assignmentId}/submissions`, {
    method: "POST",
    as: studentId,
    form: payload,
  });
}

export async function gradeAndComment(courseId, assignmentId, studentId, { grade, comment }) {
  const form = {};
  if (grade != null) form["submission[posted_grade]"] = grade;
  if (comment) form["comment[text_comment]"] = comment;
  return api(`/courses/${courseId}/assignments/${assignmentId}/submissions/${studentId}`, {
    method: "PUT",
    form,
  });
}

/**
 * Canvas de-duplicates `submission_history` by `submitted_at` at one-second
 * resolution — two versions sharing a second are reported as one attempt, even
 * though both rows exist in `versions`.
 *
 * A student resubmitting days later never notices. A seeder firing two
 * submissions in the same tick gets a single-entry history and a very
 * convincing false negative: `attempt` reads 2, the history reads 1, and it
 * looks like the exporter dropped an attempt.
 */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Bounded concurrency. Canvas is a local Rails app, not a CDN — 4 is plenty. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}
