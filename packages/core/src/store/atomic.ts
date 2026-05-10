import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (isNotFoundError(error)) {
      return fallback;
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Could not parse JSON file: ${filePath}. ${error.message}`);
    }
    throw error;
  }
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export interface AtomicWriteTextOptions {
  overwrite?: boolean;
}

export async function atomicWriteText(
  filePath: string,
  value: string,
  options: AtomicWriteTextOptions = {}
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  if (options.overwrite === false) {
    try {
      await writeFile(filePath, value, { encoding: "utf8", flag: "wx" });
      return;
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new Error(`File already exists: ${filePath}`);
      }
      throw error;
    }
  }

  const tempPath = join(
    dirname(filePath),
    `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    await writeFile(tempPath, value, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    if (isAlreadyExistsError(error)) {
      throw new Error(`File already exists: ${filePath}`);
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
