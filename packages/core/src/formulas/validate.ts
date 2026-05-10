import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { formulaSchema } from "@c3qo/samx-schemas";
import { ZodError } from "zod";
import { parse as parseYaml } from "yaml";

export interface ValidateFormulaFilesOptions {
  cwd: string;
  path?: string;
}

export interface ValidateFormulaFilesResult {
  count: number;
}

class FormulaValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(errors.join("\n"));
  }
}

export async function validateFormulaFiles(
  options: ValidateFormulaFilesOptions
): Promise<ValidateFormulaFilesResult> {
  const target = resolve(options.cwd, options.path ?? ".");
  const files = await formulaYamlFiles(target);
  const errors: string[] = [];

  if (files.length === 0) {
    throw new FormulaValidationError([`${target}: no formula YAML files found`]);
  }

  for (const file of files) {
    try {
      const raw = await readFile(file, "utf8");
      const parsed = parseYaml(raw);
      const conventionError = formulaPathConventionError(file, parsed);
      if (conventionError) errors.push(`${file}: ${conventionError}`);
      formulaSchema.parse(parsed);
    } catch (error) {
      if (error instanceof ZodError) {
        errors.push(
          ...error.issues.map(
            (issue) =>
              `${file}: ${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`
          )
        );
      } else {
        errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (errors.length > 0) throw new FormulaValidationError(errors);
  return { count: files.length };
}

async function formulaYamlFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) {
    if (!path.endsWith(".yaml"))
      throw new FormulaValidationError([`${path}: formula file must end with .yaml`]);
    return [path];
  }
  if (!info.isDirectory()) throw new FormulaValidationError([`${path}: not a file or directory`]);
  return listYamlFiles(path);
}

async function listYamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listYamlFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".yaml")) files.push(path);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function formulaPathConventionError(file: string, parsed: unknown): string | undefined {
  const formulaId =
    typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "string"
      ? parsed.id
      : undefined;
  if (!formulaId) return undefined;
  const parts = resolve(file).split(sep);
  const index = parts.lastIndexOf("formulas");
  if (index < 0) return undefined;
  const actual = parts.slice(index).join("/");
  const expected = `formulas/${formulaId}.yaml`;
  if (actual === expected) return undefined;
  return `formula path must match id: expected ${expected}`;
}
