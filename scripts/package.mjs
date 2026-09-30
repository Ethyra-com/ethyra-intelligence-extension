/**
 * Build the Chrome Web Store zip.
 *
 *   node scripts/package.mjs        → dist/ethyra-canvas-export-<version>.zip
 *
 * The working tree is the development build: its manifest keeps the localhost
 * and Azure dev hosts so "Load unpacked" can point at a local or dev backend.
 * Neither may ship (Web Store rejection code Purple Potassium), so the release
 * manifest is rewritten here rather than by hand before each upload.
 *
 * Only runtime files go in. Excluded:
 *   - dev tooling, tests, screenshots, docs, `.github`, `_metadata`;
 *   - upstream files nothing loads (see NOTICE, "Still present, deliberately
 *     not loaded"). Shipping them would put a `chrome.downloads` queue and an
 *     unused minified library in front of a reviewer for no benefit.
 * `LICENSE` and `NOTICE` stay: the MIT licence requires the notice to ship.
 *
 * No dependencies: the zip is written with `node:zlib`.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Host permissions for local and Azure dev backends. Stripped from the release. */
export const DEV_HOST = /localhost|127\.0\.0\.1|azurewebsites\.net/;

/** The only hosts a release may ask for. Anything else fails the build. */
export const RELEASE_HOSTS = [
  "*://*.instructure.com/*",
  "*://*.canvas-user-content.com/*",
  "https://api.ethyra.com/*",
];

const EXCLUDED_DIRS = new Set([
  ".git", ".github", ".claude", "_metadata", "dev", "dist", "node_modules",
  "screenshots", "scripts", "tests",
]);

/** Upstream files kept in the tree for clean merges, and loaded by nothing. */
export const UPSTREAM_UNLOADED = [
  "background.js", "content.js", "popup.html", "popup.js", "options.html",
  "options.js", "ui.js", "turndown.min.js", "turndown-plugin-gfm.min.js",
];

const EXCLUDED_FILES = new Set(["manifest.json", ".gitignore", ".DS_Store", ...UPSTREAM_UNLOADED]);

function excluded(rel) {
  const name = rel.split("/").pop();
  return (
    EXCLUDED_FILES.has(rel) ||
    name === ".DS_Store" ||
    name.endsWith(".md") ||
    name.endsWith(".test.mjs")
  );
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const abs = join(dir, entry);
    const rel = relative(ROOT, abs).split(sep).join("/");
    if (statSync(abs).isDirectory()) {
      if (!EXCLUDED_DIRS.has(rel)) walk(abs, out);
    } else if (!excluded(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/** The release manifest: the dev hosts removed, and nothing unexpected left. */
export function releaseManifest(manifest) {
  const release = {
    ...manifest,
    host_permissions: manifest.host_permissions.filter((h) => !DEV_HOST.test(h)),
  };
  const unexpected = release.host_permissions.filter((h) => !RELEASE_HOSTS.includes(h));
  if (unexpected.length) {
    throw new Error(`Unexpected host permission(s) in the release: ${unexpected.join(", ")}`);
  }
  return release;
}

/**
 * Everything that goes in the zip, as `path → Buffer`, without writing it.
 * Exported so the tests can check the package itself.
 */
export function buildPackage(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const files = new Map([["manifest.json", Buffer.from(JSON.stringify(releaseManifest(manifest), null, 2) + "\n")]]);
  for (const rel of walk(root)) files.set(rel, readFileSync(join(root, rel)));
  return { version: manifest.version, files };
}

/** A minimal zip (deflate, no zip64). A store package is well under 4 GB. */
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  // 1980-01-01, the zip epoch: a fixed time keeps the output reproducible.
  const time = 0;
  const date = (1 << 5) | 1;

  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); //             version needed
    header.writeUInt16LE(0x0800, 6); //         UTF-8 names
    header.writeUInt16LE(8, 8); //              deflate
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);

    offset += header.length + nameBuf.length + packed.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version, files } = buildPackage();
  const out = join(ROOT, "dist", `ethyra-canvas-export-${version}.zip`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zip(files));
  console.log(`${relative(ROOT, out)}: ${files.size} files, version ${version}`);
  for (const name of files.keys()) console.log(`  ${name}`);
}
