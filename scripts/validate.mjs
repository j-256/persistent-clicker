import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_PACKAGE_FILES } from "./package-files.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const DOCUMENTATION_EXTENSIONS = new Set([".adoc", ".md", ".mdx", ".rst"]);
const JAVASCRIPT_EXTENSIONS = new Set([".js", ".mjs"]);
const PRIVATE_PATH_PATTERN = /\/(?:repo|x|c|z)\/|\/Users\/[^/\s]+\//;
const MINIMUM_CHROME_VERSION = "127";
const REQUIRED_FILES = Object.freeze([...new Set([
  ...EXTENSION_PACKAGE_FILES,
  "PRIVACY.md",
  "README.md",
  "docs/screenshots/dashboard.png",
  "docs/screenshots/dashboard-dark.png",
  "docs/screenshots/picker.png",
  "docs/screenshots/popup.png",
  "docs/screenshots/popup-dark.png",
  "docs/screenshots/right-click.png",
  "icons/icon.svg",
  "store-assets/listing.md",
  "store-assets/promo-small.png",
  "store-assets/screenshot-picker.png"
])]);
const REQUIRED_PNG_DIMENSIONS = Object.freeze({
  "icons/icon-128.png": Object.freeze({ height: 128, width: 128 }),
  "store-assets/promo-small.png": Object.freeze({ height: 280, width: 440 }),
  "store-assets/screenshot-picker.png": Object.freeze({ height: 800, width: 1_280 })
});

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function collectFiles(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectFiles(path, extensions));
    } else if (extensions.has(extname(entry.name))) {
      files.push(path);
    }
  }

  return files;
}

async function readPngDimensions(path) {
  const image = await readFile(path);
  assert.equal(
    image.subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
    `${path.slice(ROOT.length + 1)} must be a PNG file`
  );
  assert.equal(
    image.subarray(12, 16).toString("ascii"),
    "IHDR",
    `${path.slice(ROOT.length + 1)} must start with a PNG IHDR chunk`
  );
  return {
    height: image.readUInt32BE(20),
    width: image.readUInt32BE(16)
  };
}

for (const relativePath of REQUIRED_FILES) {
  const details = await stat(join(ROOT, relativePath));
  assert(details.isFile(), `${relativePath} must be a file`);
  assert(details.size > 0, `${relativePath} must not be empty`);
}

const manifest = await readJson(join(ROOT, "manifest.json"));
const packageJson = await readJson(join(ROOT, "package.json"));
assert.equal(manifest.manifest_version, 3, "manifest_version must be 3");
assert.equal(
  manifest.minimum_chrome_version,
  MINIMUM_CHROME_VERSION,
  `minimum_chrome_version must support chrome.action.openPopup (${MINIMUM_CHROME_VERSION}+)`
);
assert.equal(manifest.version, packageJson.version, "manifest and package versions must match");
assert(
  manifest.description.length <= 132,
  "the manifest description must fit the Chrome Web Store limit"
);
assert.equal(manifest.background?.type, "module", "the service worker must be a module");
assert.equal(manifest.background?.service_worker, "src/background.js");
assert.deepEqual(manifest.permissions, [
  "contextMenus",
  "scripting",
  "storage"
]);
assert.deepEqual(manifest.host_permissions, [
  "http://*/*",
  "https://*/*",
  "file:///*"
]);
assert.equal(packageJson.dependencies, undefined, "the extension must have no runtime dependencies");
assert.equal(packageJson.license, "AGPL-3.0-only");

for (const [relativePath, expected] of Object.entries(REQUIRED_PNG_DIMENSIONS)) {
  assert.deepEqual(await readPngDimensions(join(ROOT, relativePath)), expected);
}

for (const relativePath of ["popup/popup.html", "dashboard/dashboard.html"]) {
  const html = await readFile(join(ROOT, relativePath), "utf8");
  assert(
    !/<script(?![^>]*\bsrc=)[^>]*>/i.test(html),
    `${relativePath} scripts must be external`
  );
  assert(!/https?:\/\//i.test(html), `${relativePath} assets must be packaged locally`);
}

for (const path of await collectFiles(ROOT, DOCUMENTATION_EXTENSIONS)) {
  const content = await readFile(path, "utf8");
  assert(
    !PRIVATE_PATH_PATTERN.test(content),
    `${path.slice(ROOT.length + 1)} must not contain a machine-local path`
  );
}

for (const path of await collectFiles(ROOT, JAVASCRIPT_EXTENSIONS)) {
  const checked = spawnSync(process.execPath, ["--check", path], {
    encoding: "utf8"
  });
  assert.equal(
    checked.status,
    0,
    `Syntax check failed for ${path.slice(ROOT.length + 1)}\n${checked.stderr}`
  );
}

console.log("Manifest, packaged assets, documentation paths, permissions, and JavaScript syntax are valid");
