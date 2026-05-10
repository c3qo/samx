import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Formula } from "@c3qo/samx-schemas";
import { formulaSchema } from "@c3qo/samx-schemas";
import { parse as parseYaml } from "yaml";

import { listRegistries } from "../registries/store.js";
import { samxPaths, validateStoreId } from "../store/paths.js";

export interface FormulaIdParts {
  registry: string;
  formula: string;
}

export interface ReadFormulaOptions {
  samxHome?: string;
  id: string;
}

export interface SearchFormulasOptions {
  samxHome?: string;
  query: string;
}

export interface FormulaSearchResult {
  id: string;
  name: string;
  description?: string;
}

export type ReadFormulaResult = Formula & { raw: string };

export interface FormulaFile {
  registry: string;
  path: string;
  formula: ReadFormulaResult;
  raw: string;
}

export function splitFormulaId(id: string): FormulaIdParts {
  if (id.includes("\\")) throw new Error(`Invalid formula id: ${id}`);
  const parts = id.split("/");
  if (parts.length !== 3 || parts.some((part) => part === "")) {
    throw new Error("Formula id must be <registry>/<owner>/<repo>");
  }
  const [registry, owner, repo] = parts;
  validateStoreId(registry);
  const formula = `${owner}/${repo}`;
  validateFormulaId(formula);
  return { registry, formula };
}

function validateFormulaId(id: string): void {
  const parts = id.split("/");
  if (
    parts.length !== 2 ||
    id === "" ||
    isAbsolute(id) ||
    id.includes("..") ||
    id.includes("\\") ||
    parts.some((part) => part === "")
  ) {
    throw new Error(`Invalid formula id: ${id}`);
  }
}

export async function readFormula(options: ReadFormulaOptions): Promise<ReadFormulaResult> {
  return (await readFormulaFile(options)).formula;
}

export async function readFormulaFile(options: ReadFormulaOptions): Promise<FormulaFile> {
  const { registry, formula } = splitFormulaId(options.id);
  const path = formulaPath(options.samxHome, registry, formula);
  const raw = await readFile(path, "utf8");
  const parsed = formulaSchema.parse(parseYaml(raw));
  if (parsed.id !== formula) {
    throw new Error(`Formula id mismatch: expected ${formula}, got ${parsed.id}`);
  }
  return { registry, path: `formulas/${formula}.yaml`, formula: { ...parsed, raw }, raw };
}

export async function searchFormulas(
  options: SearchFormulasOptions
): Promise<FormulaSearchResult[]> {
  const query = options.query.toLowerCase();
  const results: FormulaSearchResult[] = [];
  for (const registry of await listRegistries(options)) {
    const dir = join(samxPaths(options.samxHome).registryRoot(registry.id), "formulas");
    const files = await listFormulaYamlFiles(dir);
    for (const file of files) {
      const formulaId = file.slice(0, -5);
      const formula = await readFormula({
        samxHome: options.samxHome,
        id: `${registry.id}/${formulaId}`,
      });
      const qualifiedId = `${registry.id}/${formula.id}`;
      const haystack =
        `${qualifiedId}\n${formula.name}\n${formula.description ?? ""}`.toLowerCase();
      if (haystack.includes(query)) {
        results.push({
          id: qualifiedId,
          name: formula.name,
          ...(formula.description === undefined ? {} : { description: formula.description }),
        });
      }
    }
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

function formulaPath(
  samxHome: string | undefined,
  registry: string,
  formula: string
): string {
  validateFormulaId(formula);
  return join(samxPaths(samxHome).registryRoot(registry), "formulas", `${formula}.yaml`);
}

async function listFormulaYamlFiles(dir: string, prefix = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFormulaYamlFiles(join(dir, entry.name), relativePath)));
    } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
      files.push(relativePath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}
