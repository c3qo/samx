import { readFile } from "node:fs/promises";

import type { Finding, Permissions, Requirements } from "@c3qo/samx-schemas";
import { parse as parseYaml } from "yaml";

import { loadBuiltinConfigRegistrySync } from "./config/loader.js";
import type { ConfigRegistry } from "./config/types.js";
import type { ClassifiedExtension } from "./classifier.js";

export interface ParsedExtension extends ClassifiedExtension {
  rawContent: string;
  metadata: Record<string, unknown>;
  declaredRequirements: Requirements;
  declaredPermissions: Permissions;
  findings: Finding[];
}

export interface ParseExtensionFileOptions {
  registry?: ConfigRegistry;
}

const emptyRequirements = (): Requirements => ({ commands: [], env: [], paths: [] });
const emptyPermissions = (): Permissions => ({
  shell: false,
  network: false,
  filesystem: [],
  browser: false,
  secrets: [],
});

export async function parseExtensionFile(
  classified: ClassifiedExtension,
  options: ParseExtensionFileOptions = {}
): Promise<ParsedExtension> {
  const registry = options.registry ?? loadBuiltinConfigRegistrySync();
  const rawContent = await readFile(classified.sourcePath, "utf8");
  const parsed = baseParsed(classified, rawContent);

  if (registry.parse.markdownFrontmatterKinds.includes(classified.kind)) {
    return parseFrontmatterMarkdown(parsed);
  }

  if (registry.parse.mcpJsonKinds.includes(classified.kind)) {
    return parseMcpJson(parsed);
  }

  if (registry.parse.profileKinds.includes(classified.kind)) {
    return parseProfile(parsed);
  }

  if (registry.parse.packageJsonKinds.includes(classified.kind)) {
    return parsePackageJson(parsed);
  }

  return { ...parsed, metadata: { body: rawContent } };
}

function baseParsed(classified: ClassifiedExtension, rawContent: string): ParsedExtension {
  return {
    ...classified,
    rawContent,
    metadata: {},
    declaredRequirements: emptyRequirements(),
    declaredPermissions: emptyPermissions(),
    findings: [],
  };
}

function parseFrontmatterMarkdown(parsed: ParsedExtension): ParsedExtension {
  const frontmatter = splitFrontmatter(parsed.rawContent);

  if (!frontmatter) {
    return { ...parsed, metadata: { body: parsed.rawContent } };
  }

  try {
    const yamlMetadata = parseYaml(frontmatter.yaml);
    const metadata = isRecord(yamlMetadata) ? { ...yamlMetadata } : {};
    const declaredRequirements = requirementsFrom(metadata.requirements);
    const declaredPermissions = permissionsFrom(metadata.permissions);
    delete metadata.requirements;
    delete metadata.permissions;

    return {
      ...parsed,
      metadata: { ...metadata, body: frontmatter.body },
      declaredRequirements,
      declaredPermissions,
    };
  } catch (error) {
    return {
      ...parsed,
      metadata: { body: frontmatter.body },
      findings: [parseFinding(parsed, "Could not parse YAML frontmatter", errorMessage(error))],
    };
  }
}

function parseMcpJson(parsed: ParsedExtension): ParsedExtension {
  try {
    const json = JSON.parse(parsed.rawContent) as unknown;
    const root = isRecord(json) ? json : {};
    const servers = isRecord(root.mcpServers)
      ? root.mcpServers
      : isRecord(root.servers)
        ? root.servers
        : {};

    return {
      ...parsed,
      metadata: { servers },
      declaredRequirements: requirementsFromMcpServers(servers),
    };
  } catch (error) {
    return {
      ...parsed,
      findings: [parseFinding(parsed, "Could not parse JSON file", errorMessage(error))],
    };
  }
}

function parseProfile(parsed: ParsedExtension): ParsedExtension {
  return {
    ...parsed,
    metadata: {
      title: firstMarkdownTitle(parsed.rawContent) ?? parsed.name,
      body: parsed.rawContent,
    },
  };
}

function parsePackageJson(parsed: ParsedExtension): ParsedExtension {
  try {
    const json = JSON.parse(parsed.rawContent) as unknown;
    const root = isRecord(json) ? json : {};
    const metadata = pickPackageMetadata(root);

    return {
      ...parsed,
      metadata,
      declaredRequirements: { ...emptyRequirements(), paths: packageBinPaths(metadata.bin) },
    };
  } catch (error) {
    return {
      ...parsed,
      findings: [parseFinding(parsed, "Could not parse JSON file", errorMessage(error))],
    };
  }
}

function splitFrontmatter(content: string): { yaml: string; body: string } | undefined {
  if (!content.startsWith("---\n")) {
    return undefined;
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return undefined;
  }

  const closingEnd = content.startsWith("\n", end + 4) ? end + 5 : end + 4;
  return {
    yaml: content.slice(4, end),
    body: content.slice(closingEnd),
  };
}

function requirementsFrom(value: unknown): Requirements {
  if (!isRecord(value)) {
    return emptyRequirements();
  }

  return {
    commands: stringArray(value.commands),
    env: stringArray(value.env),
    paths: stringArray(value.paths),
  };
}

function permissionsFrom(value: unknown): Permissions {
  if (!isRecord(value)) {
    return emptyPermissions();
  }

  return {
    shell: value.shell === true,
    network: value.network === true,
    filesystem: stringArray(value.filesystem),
    browser: value.browser === true,
    secrets: stringArray(value.secrets),
  };
}

function requirementsFromMcpServers(servers: Record<string, unknown>): Requirements {
  const commands: string[] = [];
  const env: string[] = [];

  for (const server of Object.values(servers)) {
    if (!isRecord(server)) {
      continue;
    }

    if (typeof server.command === "string" && server.command.length > 0) {
      commands.push(server.command);
    }

    if (isRecord(server.env)) {
      env.push(...Object.keys(server.env));
    }
  }

  return { commands: unique(commands), env: unique(env), paths: [] };
}

function pickPackageMetadata(root: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const key of ["name", "version", "bin", "scripts"]) {
    if (root[key] !== undefined) {
      metadata[key] = root[key];
    }
  }

  return metadata;
}

function packageBinPaths(bin: unknown): string[] {
  if (typeof bin === "string" && bin.length > 0) {
    return [bin];
  }

  if (!isRecord(bin)) {
    return [];
  }

  return unique(
    Object.values(bin).filter(
      (value): value is string => typeof value === "string" && value.length > 0
    )
  );
}

function firstMarkdownTitle(content: string): string | undefined {
  const title = content.split("\n").find((line) => line.startsWith("# "));
  return title?.replace(/^#\s+/u, "").trim() || undefined;
}

function parseFinding(parsed: ParsedExtension, title: string, message: string): Finding {
  return {
    id: `${parsed.id}:parse-error`,
    severity: "low",
    status: "warning",
    category: "inventory",
    extensionId: parsed.id,
    title,
    message,
    source: parsed.sourcePath,
    confidence: "low",
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return unique(
    value.filter((item): item is string => typeof item === "string" && item.length > 0)
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
