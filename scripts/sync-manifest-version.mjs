import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
const manifestPath = join(ROOT, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

manifest.version = packageJson.version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
