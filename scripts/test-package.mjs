import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(ROOT, "manifest.json"), "utf8"));
const archivePath = join(
  ROOT,
  "dist",
  `persistent-clicker-${manifest.version}.zip`
);
const extensionRoot = await mkdtemp(join(tmpdir(), "persistent-clicker-package-"));

try {
  const entries = unzipSync(new Uint8Array(await readFile(archivePath)));

  for (const [relativePath, content] of Object.entries(entries)) {
    assert(!isAbsolute(relativePath), `Archive path must be relative: ${relativePath}`);
    assert(
      !relativePath.split("/").includes(".."),
      `Archive path must not escape its root: ${relativePath}`
    );
    const destination = join(extensionRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }

  const result = spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "browser.mjs"), "test"],
    {
      env: {
        ...process.env,
        PERSISTENT_CLICKER_EXTENSION_ROOT: extensionRoot
      },
      stdio: "inherit"
    }
  );
  assert.equal(result.status, 0, "Packaged extension browser verification failed");
} finally {
  await rm(extensionRoot, { recursive: true, force: true });
}
