/**
 * The per-file upload: fetch and hash each course's files, ask which are new,
 * PUT only those, then complete with the manifest.
 *
 *   node --test "ethyra/*.test.mjs"
 *
 * `fetch` is a fake that records every request and answers from a script, so
 * these run offline and can fail a file on purpose. Canvas downloads are
 * `data:` URLs, which the fake serves as their own contents.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.test";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const file = (name, text, extra = {}) => ({
  path: "Algebra-1/Essay-2/",
  filename: name,
  url: `data:text/plain,${encodeURIComponent(text)}`,
  size: text.length,
  ...extra,
});

function load(respond) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    if (url.startsWith("data:")) {
      if (url.includes("BROKEN")) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      const body = new TextEncoder().encode(decodeURIComponent(url.slice(url.indexOf(",") + 1)));
      return { ok: true, status: 200, arrayBuffer: async () => body.buffer };
    }
    const call = { url, method: init.method, headers: init.headers || {}, body: init.body };
    calls.push(call);
    const { status = 200, json = {}, throws } = (await respond(call, calls)) || {};
    if (throws) throw throws;
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  const sandbox = vm.createContext({
    console,
    fetch,
    crypto,
    TextEncoder,
    Uint8Array,
    DOMException,
    setTimeout,
    clearTimeout,
  });
  for (const f of ["ethyra/archive.js", "ethyra/upload.js"]) {
    vm.runInContext(readFileSync(join(ROOT, f), "utf8"), sandbox, { filename: f });
  }
  sandbox.setTimeout = (fn) => fn(); // no real waiting between retries
  return { sandbox, calls };
}

/** A backend that has `have` already and signs a URL for everything else. */
function backend(have = []) {
  return (call) => {
    if (call.url.endsWith("/files")) {
      const asked = JSON.parse(call.body).files.map((f) => f.sha256);
      const upload = Object.fromEntries(
        asked.filter((h) => !have.includes(h)).map((h) => [h, `https://blobs.test/u/files/${h}?sig=x`])
      );
      return { json: { upload } };
    }
    if (call.url.endsWith("/complete")) return { json: { id: "abc", status: "pending" } };
    return { status: 201 };
  };
}

const puts = (calls) => calls.filter((c) => c.method === "PUT");

async function send(sandbox, files, events = []) {
  const sender = sandbox.createFileSender({ apiUrl: API, accessToken: "t", onProgress: (e) => events.push(e) });
  const result = await sender.sendCourse({ course: "Algebra", files, index: 0, total: 1 });
  return { sender, ...result };
}

test("each new file is hashed and PUT once to its own URL", async () => {
  const { sandbox, calls } = load(backend());
  const events = [];
  const { hashes, failed, sender } = await send(sandbox, [file("a.txt", "alpha"), file("b.txt", "beta")], events);

  assert.equal(failed.length, 0);
  assert.equal(hashes.get("Algebra-1/Essay-2/a.txt").sha256, sha("alpha"));
  assert.equal(hashes.get("Algebra-1/Essay-2/a.txt").size, 5);

  const sent = puts(calls);
  assert.deepEqual(sent.map((c) => c.url.split("/files/")[1].split("?")[0]).sort(), [sha("alpha"), sha("beta")].sort());
  assert.ok(sent.every((c) => c.headers["x-ms-blob-type"] === "BlockBlob"), "a single PUT names its blob type");
  assert.equal(sender.sent, 2);
  assert.equal(events.at(-1).phase, "sending");
});

test("a file the student already sent is skipped, not re-sent", async () => {
  const { sandbox, calls } = load(backend([sha("alpha")]));
  const { hashes, sender } = await send(sandbox, [file("a.txt", "alpha"), file("b.txt", "beta")]);
  assert.equal(puts(calls).length, 1);
  assert.ok(hashes.has("Algebra-1/Essay-2/a.txt"), "a skipped file is still named in the manifest");
  assert.equal(sender.skipped, 1);
});

test("the same bytes twice in one course are sent once", async () => {
  const { sandbox, calls } = load(backend());
  await send(sandbox, [file("a.txt", "same"), file("copy of a.txt", "same")]);
  assert.equal(puts(calls).length, 1);
});

test("a file Canvas will not serve is reported, and the rest still go", async () => {
  const { sandbox, calls } = load(backend());
  const { failed, hashes } = await send(sandbox, [file("a.txt", "alpha"), file("gone.txt", "x", { url: "data:BROKEN" })]);
  assert.deepEqual([...failed], ["Algebra-1/Essay-2/gone.txt"]);
  assert.ok(!hashes.has("Algebra-1/Essay-2/gone.txt"));
  assert.equal(puts(calls).length, 1);
});

test("a PUT that fails is retried on its own", async () => {
  let failures = 2;
  const { sandbox, calls } = load((call) => {
    if (call.method === "PUT" && failures > 0) {
      failures--;
      return { status: 503 };
    }
    return backend()(call);
  });
  await send(sandbox, [file("a.txt", "alpha")]);
  assert.equal(puts(calls).length, 3);
});

test("a 403 (the file already there) is not retried and does not fail the export", async () => {
  // Create-only URLs answer a second PUT of a stored file with 403. `complete`
  // is what checks every file arrived, so an expired URL is caught there.
  const { sandbox, calls } = load((call) => (call.method === "PUT" ? { status: 403 } : backend()(call)));
  const { failed, hashes } = await send(sandbox, [file("a.txt", "alpha")]);
  assert.equal(failed.length, 0);
  assert.ok(hashes.has("Algebra-1/Essay-2/a.txt"));
  assert.equal(puts(calls).length, 1);
});

test("a course bigger than a batch is asked about in batches", async () => {
  const { sandbox, calls } = load(backend());
  const files = Array.from({ length: 20 }, (_, i) => file(`f${i}.txt`, `body ${i}`));
  await send(sandbox, files);
  assert.equal(calls.filter((c) => c.url.endsWith("/files")).length, 3, "8 + 8 + 4");
  assert.equal(puts(calls).length, 20);
});

for (const [name, answer] of [
  ["404", { status: 404 }],
  ["501, cannot sign", { status: 501 }],
  ["a failed preflight", { throws: new TypeError("Failed to fetch") }],
]) {
  test(`a backend without /files (${name}) switches to one zip before sending anything`, async () => {
    const { sandbox, calls } = load(() => answer);
    const { sender, hashes } = await send(sandbox, [file("a.txt", "alpha")]);
    assert.equal(sender.mode, "zip");
    assert.equal(hashes, null);
    assert.equal(puts(calls).length, 0, "nothing went to storage");

    // Later courses do not ask again.
    await sender.sendCourse({ course: "Next", files: [file("b.txt", "beta")], index: 1, total: 2 });
    assert.equal(calls.length, 1);
  });
}

test("a refusal from /files is the backend's own message", async () => {
  const { sandbox } = load(() => ({ status: 413, json: { detail: "A file is larger than the 50 MB limit for one file." } }));
  await assert.rejects(send(sandbox, [file("a.txt", "alpha")]), /50 MB limit/);
});

test("complete sends the manifest with a fresh upload id", async () => {
  const { sandbox, calls } = load(backend());
  const manifest = { manifest_version: 1, courses: [] };
  const upload = await sandbox.completeUpload({ apiUrl: API, accessToken: "t", manifest, studentName: "Ada" });
  assert.equal(upload.id, "abc");
  const body = JSON.parse(calls[0].body);
  assert.match(body.upload_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body.manifest, manifest);
  assert.equal(body.student_name, "Ada");
});

test("the token is asked for on every call, so a long export outlives the first one", async () => {
  const { sandbox, calls } = load(backend());
  let n = 0;
  const sender = sandbox.createFileSender({ apiUrl: API, accessToken: async () => `token-${++n}` });
  const files = Array.from({ length: 10 }, (_, i) => file(`f${i}.txt`, `body ${i}`));
  await sender.sendCourse({ course: "Algebra", files, index: 0, total: 1 });
  await sandbox.completeUpload({ apiUrl: API, accessToken: async () => `token-${++n}`, manifest: {}, studentName: null });

  const auth = calls.filter((c) => c.headers.Authorization).map((c) => c.headers.Authorization);
  assert.deepEqual(auth, ["Bearer token-1", "Bearer token-2", "Bearer token-3"], "two /files batches, then complete");
});

test("an export over the cap stops before sending the batch that crosses it", async () => {
  const { sandbox, calls } = load(backend());
  const sender = sandbox.createFileSender({ apiUrl: API, accessToken: "t", maxTotalBytes: 12 });
  // 8 files of 6 bytes each go in one batch: 48 bytes, over a 12-byte cap.
  const files = Array.from({ length: 8 }, (_, i) => file(`f${i}.txt`, `body-${i}`));
  await assert.rejects(
    sender.sendCourse({ course: "Algebra", files, index: 0, total: 1 }),
    /over Ethyra's .* limit, so the export stopped at Algebra\. What was already sent is kept/
  );
  assert.equal(puts(calls).length, 0, "nothing in the crossing batch is sent");
  assert.equal(calls.length, 0, "not even asked about");
});

test("files skipped as already sent still count toward the cap", async () => {
  const { sandbox } = load(backend([sha("alpha"), sha("beta")]));
  // "alpha" (5) + "beta" (4) is 9 bytes, over 8, though neither is sent.
  const sender = sandbox.createFileSender({ apiUrl: API, accessToken: "t", maxTotalBytes: 8 });
  await sender.sendCourse({ course: "A", files: [file("a.txt", "alpha")], index: 0, total: 2 });
  await assert.rejects(
    sender.sendCourse({ course: "B", files: [file("b.txt", "beta")], index: 1, total: 2 }),
    /stopped at B/
  );
});

test("a network failure after /files has worked is retried, never a switch to one zip", async () => {
  let dropped = 0;
  let asked = 0;
  const { sandbox, calls } = load((call) => {
    if (call.url.endsWith("/files") && ++asked === 2 && dropped++ < 2) {
      asked--; // the dropped attempts do not count as the second request
      return { throws: new TypeError("Failed to fetch") };
    }
    return backend()(call);
  });
  const sender = sandbox.createFileSender({ apiUrl: API, accessToken: "t" });
  await sender.sendCourse({ course: "A", files: [file("a.txt", "alpha")], index: 0, total: 2 });
  const { hashes } = await sender.sendCourse({ course: "B", files: [file("b.txt", "beta")], index: 1, total: 2 });

  assert.equal(sender.mode, "files", "the route exists; an outage is not a reason to zip");
  assert.ok(hashes.has("Algebra-1/Essay-2/b.txt"));
  assert.equal(calls.filter((c) => c.url.endsWith("/files")).length, 4, "one, then two dropped, then the retry");
  assert.equal(puts(calls).length, 2);
});

test("a 404 after /files has worked is an error, not a fallback", async () => {
  let asked = 0;
  const { sandbox } = load((call) =>
    call.url.endsWith("/files") && ++asked > 1 ? { status: 404, json: { detail: "Not Found" } } : backend()(call)
  );
  const sender = sandbox.createFileSender({ apiUrl: API, accessToken: "t" });
  await sender.sendCourse({ course: "A", files: [file("a.txt", "alpha")], index: 0, total: 2 });
  await assert.rejects(
    sender.sendCourse({ course: "B", files: [file("b.txt", "beta")], index: 1, total: 2 }),
    /Not Found/
  );
  assert.equal(sender.mode, "files");
});

test("an outage that outlasts the retries fails the export with the backend unreachable", async () => {
  let asked = 0;
  const { sandbox } = load((call) =>
    call.url.endsWith("/files") && ++asked > 1 ? { throws: new TypeError("Failed to fetch") } : backend()(call)
  );
  const sender = sandbox.createFileSender({ apiUrl: API, accessToken: "t" });
  await sender.sendCourse({ course: "A", files: [file("a.txt", "alpha")], index: 0, total: 2 });
  await assert.rejects(
    sender.sendCourse({ course: "B", files: [file("b.txt", "beta")], index: 1, total: 2 }),
    /Could not reach Ethyra/
  );
  assert.equal(sender.mode, "files");
});
