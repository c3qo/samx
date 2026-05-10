import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const binPath = resolve("node_modules/.bin/samx");
const entryPath = resolve("dist/index.js");
const shim = `#!/bin/sh\nexec node "${entryPath}" "$@"\n`;

await mkdir(dirname(binPath), { recursive: true });
await writeFile(binPath, shim, "utf8");
await chmod(binPath, 0o755);
await chmod(entryPath, 0o755);
