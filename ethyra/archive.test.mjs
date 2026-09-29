/**
 * The one-zip fallback's archive, built with the real client-zip.
 *
 *   node --test "ethyra/*.test.mjs"
 *
 * Only for a backend without per-file upload, whose single request takes 500 MB.
 * What matters here is that an archive over that stops being built when it
 * crosses the limit, rather than after all of it is in memory.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function load() {
  const sandbox = vm.createContext({
    console,
    fetch,
    Response,
    ReadableStream,
    Blob,
    File,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    DataView,
    ArrayBuffer,
    Date,
  });
  for (const f of ["client-zip.min.js", "ethyra/manifest.js", "ethyra/archive.js"]) {
    vm.runInContext(readFileSync(join(ROOT, f), "utf8"), sandbox, { filename: f });
  }
  return sandbox;
}

const text = (n) => "x".repeat(n);
const file = (name, body) => ({
  path: "Algebra-1/Essay-2/",
  filename: name,
  url: `data:text/plain,${body}`,
  size: body.length,
});
const manifest = { manifest_version: 1, courses: [], captured_at: "2026-09-29T00:00:00Z" };

test("an archive under the limit is built whole", async () => {
  const { buildArchive } = load();
  const { blob, failed } = await buildArchive([file("a.txt", text(1000))], manifest, { maxBytes: 100_000 });
  assert.equal(failed.length, 0);
  assert.ok(blob.size > 1000, "the file and the zip's own records");
  assert.equal(blob.type, "application/zip");
});

test("an archive over the limit stops being built, and nothing is returned to upload", async () => {
  const { buildArchive } = load();
  const files = Array.from({ length: 20 }, (_, i) => file(`f${i}.txt`, text(10_000)));
  await assert.rejects(
    buildArchive(files, manifest, { maxBytes: 50_000 }),
    /over the 0 MB this Ethyra server takes in one upload, so nothing was uploaded/
  );
});

test("the limit counts real bytes, so a file Canvas gave no size for still counts", async () => {
  const { buildArchive } = load();
  const sizeless = { ...file("big.txt", text(60_000)), size: 0 };
  await assert.rejects(buildArchive([sizeless], manifest, { maxBytes: 50_000 }), /nothing was uploaded/);
});
