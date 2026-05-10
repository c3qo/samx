import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("../core/config/packs");
const destination = resolve("dist/config/packs");

await mkdir(resolve("dist/config"), { recursive: true });
await cp(source, destination, { recursive: true });
