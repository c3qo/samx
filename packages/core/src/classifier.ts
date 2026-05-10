import { readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";

import type { ClassifyRule, ExtensionKind, NameFrom } from "@c3qo/samx-schemas";

import { loadBuiltinConfigRegistry } from "./config/loader.js";
import type { ConfigRegistry } from "./config/types.js";

export interface ClassifiedExtension {
  id: string;
  name: string;
  kind: ExtensionKind;
  sourcePath: string;
  sourceTool?: string;
  entryFiles: string[];
}

export interface ClassifyExtensionOptions {
  cwd?: string;
  registry?: ConfigRegistry;
}

export async function classifyExtension(
  filePath: string,
  options: ClassifyExtensionOptions = {}
): Promise<ClassifiedExtension> {
  const sourcePath = resolve(filePath);
  const registry = options.registry ?? (await loadBuiltinConfigRegistry());
  const relativePath = normalizePath(
    options.cwd ? relative(resolve(options.cwd), sourcePath) : basename(sourcePath)
  );
  const fileName = basename(sourcePath);
  const extension = extname(fileName);

  for (const rule of registry.classify) {
    if (await matchesRule(rule, { sourcePath, relativePath, fileName, extension })) {
      return classified({
        sourcePath,
        relativePath,
        name: await nameForRule(rule.nameFrom, sourcePath, fileName, extension, rule.name),
        kind: rule.kind,
        sourceTool: rule.sourceTool,
      });
    }
  }

  if (fileName === "SKILL.md") {
    const name = basename(dirname(sourcePath));
    return classified({
      sourcePath,
      relativePath,
      name,
      kind: "skill",
      sourceTool: skillSourceTool(relativePath),
    });
  }

  if (relativePath.startsWith(".cursor/rules/") && extension === ".mdc") {
    return classified({
      sourcePath,
      relativePath,
      name: basename(fileName, extension),
      kind: "rule",
      sourceTool: "cursor",
    });
  }

  if (relativePath === "mcp.json" || relativePath === ".cursor/mcp.json") {
    return classified({
      sourcePath,
      relativePath,
      name: "mcp",
      kind: "mcp-server",
      sourceTool: relativePath.startsWith(".cursor/") ? "cursor" : undefined,
    });
  }

  if (fileName === "AGENTS.md" || fileName === "CLAUDE.md") {
    return classified({
      sourcePath,
      relativePath,
      name: basename(fileName, extension),
      kind: "profile",
      sourceTool: fileName === "CLAUDE.md" ? "claude" : undefined,
    });
  }

  if (fileName === "package.json" && (await packageHasBin(sourcePath))) {
    return classified({
      sourcePath,
      relativePath,
      name: await packageName(sourcePath, basename(dirname(sourcePath))),
      kind: "bundle",
    });
  }

  return classified({
    sourcePath,
    relativePath,
    name: basename(fileName, extension),
    kind: "unknown",
  });
}

interface RuleMatchInput {
  sourcePath: string;
  relativePath: string;
  fileName: string;
  extension: string;
}

async function matchesRule(rule: ClassifyRule, input: RuleMatchInput): Promise<boolean> {
  const when = rule.when;
  if (when.fileName !== undefined && when.fileName !== input.fileName) return false;
  if (when.extension !== undefined && when.extension !== input.extension) return false;
  if (when.relativePath !== undefined && when.relativePath !== input.relativePath) return false;
  if (when.pathPrefix !== undefined && !input.relativePath.startsWith(when.pathPrefix))
    return false;
  if (
    when.packageHasBin !== undefined &&
    (await packageHasBin(input.sourcePath)) !== when.packageHasBin
  )
    return false;
  return true;
}

async function nameForRule(
  nameFrom: NameFrom,
  sourcePath: string,
  fileName: string,
  extension: string,
  name?: string
): Promise<string> {
  if (nameFrom === "constant") {
    return name ?? basename(fileName, extension);
  }

  if (nameFrom === "parentDirectory") {
    if (fileName === "package.json") {
      return packageName(sourcePath, basename(dirname(sourcePath)));
    }
    return basename(dirname(sourcePath));
  }

  return basename(fileName, extension);
}

interface ClassifiedInput {
  sourcePath: string;
  relativePath: string;
  name: string;
  kind: ExtensionKind;
  sourceTool?: string;
}

function classified(input: ClassifiedInput): ClassifiedExtension {
  return {
    id: stableId(input.relativePath),
    name: input.name,
    kind: input.kind,
    sourcePath: input.sourcePath,
    sourceTool: input.sourceTool,
    entryFiles: [input.sourcePath],
  };
}

async function packageHasBin(packagePath: string): Promise<boolean> {
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { bin?: unknown };
  return typeof parsed.bin === "string" || (typeof parsed.bin === "object" && parsed.bin !== null);
}

async function packageName(packagePath: string, fallback: string): Promise<string> {
  const parsed = JSON.parse(await readFile(packagePath, "utf8")) as { name?: unknown };
  return typeof parsed.name === "string" && parsed.name.length > 0 ? parsed.name : fallback;
}

function stableId(relativePath: string): string {
  const withoutExtension = relativePath
    .replace(/\/SKILL\.md$/u, "")
    .replace(/\.mdc$/u, "")
    .replace(/\.md$/u, "")
    .replace(/\.json$/u, "");

  return withoutExtension
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/^\./u, ""))
    .join("-")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLowerCase();
}

function skillSourceTool(relativePath: string): string | undefined {
  if (relativePath.startsWith(".claude/skills/")) {
    return "claude";
  }

  if (relativePath.startsWith(".opencode/") || relativePath.startsWith(".config/opencode/")) {
    return "opencode";
  }

  return undefined;
}

function normalizePath(filePath: string): string {
  return filePath.split("\\").join("/");
}
