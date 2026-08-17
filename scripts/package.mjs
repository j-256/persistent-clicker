import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";
import { EXTENSION_PACKAGE_FILES } from "./package-files.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_ROOT = join(ROOT, "dist");
const ARCHIVE_TIMESTAMP = new Date("1980-01-01T00:00:00.000Z");
const manifest = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
const archiveName = `persistent-clicker-${manifest.version}.zip`;
const archivePath = join(DIST_ROOT, archiveName);
const entries = {};

for (const relativePath of EXTENSION_PACKAGE_FILES) {
  entries[relativePath] = [
    new Uint8Array(await readFile(join(ROOT, relativePath))),
    { level: 9, mtime: ARCHIVE_TIMESTAMP }
  ];
}

await mkdir(DIST_ROOT, { recursive: true });
const archive = zipSync(entries);
await writeFile(archivePath, archive);

const packagedFiles = Object.keys(unzipSync(archive)).sort();
assert.deepEqual(packagedFiles, [...EXTENSION_PACKAGE_FILES].sort());
assert(packagedFiles.includes("manifest.json"), "manifest.json must be at the archive root");

console.log(`Created ${archivePath}`);
