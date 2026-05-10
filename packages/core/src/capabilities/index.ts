import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type {
  CapabilityIndex,
  CapabilityType,
  IndexedCapability,
  IndexedHookAttachment,
  RecipeLock,
  SamxPackage,
  SkillIndex,
} from "@c3qo/samx-schemas";
import {
  capabilityIndexSchema,
  indexedHookAttachmentSchema,
  recipeLockSchema,
} from "@c3qo/samx-schemas";
import { z } from "zod";

import { atomicWriteJson, readJsonFile } from "../store/atomic.js";
import { samxPaths } from "../store/paths.js";
import { attachPackageHooks } from "../packages/manifest.js";
import { listLocalPackages } from "../packages/local.js";

export interface CapabilityIndexOptions {
  samxHome?: string;
}

export interface CapabilityIdOptions extends CapabilityIndexOptions {
  id: string;
}

export interface ListCapabilitiesOptions extends CapabilityIndexOptions {
  type?: CapabilityType;
}

const generatedCapabilitySchema = z
  .object({
    id: z.string().min(1),
    registry: z.string().min(1),
    formula: z.string().min(1),
    package: z.string().min(1),
    kind: z.enum(["skill", "agent", "mcp"]),
    path: z.string().min(1).optional(),
    serverName: z.string().min(1).optional(),
    config: z.record(z.unknown()).optional(),
    sourceFormat: z.enum(["claude-local", "opencode", "claude-api", "direct"]).optional(),
    transport: z.enum(["stdio", "remote"]).optional(),
    description: z.string().optional(),
    hooks: z.array(indexedHookAttachmentSchema).optional(),
  })
  .strict()
  .superRefine((capability, ctx) => {
    if (capability.kind === "skill" || capability.kind === "agent") {
      if (!capability.path)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Generated skill and agent capabilities require path",
          path: ["path"],
        });
      return;
    }
    if (
      !capability.path &&
      (!capability.serverName ||
        !capability.config ||
        !capability.sourceFormat ||
        !capability.transport)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Generated MCP capability requires path or spec fields",
      });
    }
  });

const generatedCapabilityIndexSchema = z.object({
  capabilities: z.array(generatedCapabilitySchema).default([]),
});

type GeneratedCapability = z.infer<typeof generatedCapabilitySchema>;

export async function readCapabilityIndex(
  options: CapabilityIndexOptions = {}
): Promise<CapabilityIndex> {
  const paths = samxPaths(options.samxHome);
  const capabilitiesFile = await readJsonFile<CapabilityIndex | undefined>(
    paths.capabilities,
    undefined
  );
  if (capabilitiesFile) {
    const generatedParsed = generatedCapabilityIndexSchema.safeParse(capabilitiesFile);
    if (generatedParsed.success) {
      return {
        capabilities: sortedCapabilities([
          ...(await Promise.all(
            generatedParsed.data.capabilities.map(generatedCapabilityAsIndexed)
          )),
          ...(await readLocalIndexedCapabilities(options)),
        ]),
      };
    }

    const canonicalParsed = capabilityIndexSchema.safeParse(capabilitiesFile);
    if (canonicalParsed.success) {
      return { capabilities: sortedCapabilities(canonicalParsed.data.capabilities) };
    }

    generatedCapabilityIndexSchema.parse(capabilitiesFile);
  }

  const index = await readJsonFile(paths.index, { capabilities: [] });
  if (isOldSkillIndex(index)) {
    return capabilityIndexSchema.parse({ capabilities: sortedCapabilities(index.skills) });
  }

  const parsed = capabilityIndexSchema.parse(index);
  return { capabilities: sortedCapabilities(parsed.capabilities) };
}

async function readLocalIndexedCapabilities(
  options: CapabilityIndexOptions
): Promise<IndexedCapability[]> {
  const capabilities: IndexedCapability[] = [];
  for (const pkg of await listLocalPackages(options)) {
    capabilities.push(...(await attachPackageHooks(pkg, await localPackageCapabilities(pkg))));
  }
  return capabilities;
}

export async function listCapabilities(
  options: ListCapabilitiesOptions = {}
): Promise<IndexedCapability[]> {
  const capabilities = (await readCapabilityIndex(options)).capabilities;
  return options.type
    ? capabilities.filter((capability) => capability.kind === options.type)
    : capabilities;
}

export async function regenerateCapabilities(
  options: CapabilityIndexOptions = {}
): Promise<CapabilityIndex> {
  const paths = samxPaths(options.samxHome);
  const generatedCapabilities: GeneratedCapability[] = [];
  const localCapabilities: IndexedCapability[] = [];
  for (const registry of await safeReaddir(paths.packagesDir)) {
    for (const formula of await listPackageFormulaIds(paths.packageRoot(registry))) {
      const recipeValue = await readJsonFile<RecipeLock | undefined>(
        paths.recipeLock(registry, formula),
        undefined
      );
      if (!recipeValue) {
        continue;
      }
      const recipe = recipeLockSchema.parse(recipeValue);
      const packageId = `${registry}/${formula}`;
      const sourceRoot = join(paths.packageRoot(registry, formula), "source");
      await validateRecipeCapabilities({ sourceRoot, recipe });
      for (const capability of recipe.capabilities) {
        const sourceRoot = join(paths.packageRoot(registry, formula), "source");
        if (capability.kind === "mcp" && capability.spec) {
          generatedCapabilities.push({
            id: capability.id,
            registry,
            formula,
            package: packageId,
            kind: capability.kind,
            serverName: capability.spec.serverName,
            config: capability.spec.config,
            sourceFormat: capability.spec.sourceFormat,
            transport: capability.spec.transport,
            ...(capability.description ? { description: capability.description } : {}),
          });
          continue;
        }
        if (!capability.path) throw new Error(`Recipe capability requires path: ${capability.id}`);
        const resolved = await resolveCapabilitySourcePath({
          sourceRoot,
          kind: capability.kind,
          path: capability.path,
          entry: capability.entry,
        });
        const description =
          capability.description ??
          (await readCapabilityDescription(capability.kind, resolved.entryPath));
        const hooks =
          capability.kind === "skill" || capability.kind === "agent"
            ? formulaHooksForCapability(recipe, capability.formulaCapabilityId, sourceRoot)
            : [];
        generatedCapabilities.push({
          id: capability.id,
          registry,
          formula,
          package: packageId,
          kind: capability.kind,
          path: resolved.indexPath,
          ...(description ? { description } : {}),
          ...(hooks.length > 0 ? { hooks } : {}),
        });
      }
    }
  }
  localCapabilities.push(...(await readLocalIndexedCapabilities(options)));
  const generatedIndex = generatedCapabilityIndexSchema.parse({
    capabilities: sortById(generatedCapabilities),
  });
  const canonicalIndex = capabilityIndexSchema.parse({
    capabilities: sortedCapabilities([
      ...(await Promise.all(generatedIndex.capabilities.map(generatedCapabilityAsIndexed))),
      ...localCapabilities,
    ]),
  });
  await atomicWriteJson(paths.capabilities, generatedIndex);
  await atomicWriteJson(paths.index, canonicalIndex);
  return canonicalIndex;
}

async function listPackageFormulaIds(root: string, prefix = ""): Promise<string[]> {
  const formulas: string[] = [];
  for (const entry of await safeReaddir(root, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!entry.isDirectory()) continue;
    const packageRoot = join(root, entry.name);
    const recipe = await readJsonFile<RecipeLock | undefined>(
      join(packageRoot, "recipe.lock.json"),
      undefined
    );
    if (recipe) {
      formulas.push(relativePath);
    } else {
      formulas.push(...(await listPackageFormulaIds(packageRoot, relativePath)));
    }
  }
  return formulas.sort((a, b) => a.localeCompare(b));
}

export async function validateRecipeCapabilities(options: {
  sourceRoot: string;
  recipe: RecipeLock;
}): Promise<void> {
  for (const capability of options.recipe.capabilities) {
    if (capability.kind === "mcp" && capability.spec) continue;
    if (!capability.path) throw new Error(`Recipe capability requires path: ${capability.id}`);
    validateRecipeCapabilityPath(capability.path);
    if (capability.entry) {
      validateRecipeCapabilityEntry(capability.entry);
    }
    const resolved = await resolveCapabilitySourcePath({
      sourceRoot: options.sourceRoot,
      kind: capability.kind,
      path: capability.path,
      entry: capability.entry,
    });
    await rejectEscapedCapabilityPath(options.sourceRoot, resolved.indexPath);
    await rejectEscapedCapabilityPath(options.sourceRoot, resolved.entryPath);
  }
}

async function localPackageCapabilities(
  pkg: Extract<SamxPackage, { type: "local" }>
): Promise<IndexedCapability[]> {
  const capabilities: IndexedCapability[] = [];
  for (const name of await safeReaddir(join(pkg.path, "skills"))) {
    const path = join(pkg.path, "skills", name);
    const body = await readFile(join(path, "SKILL.md"), "utf8");
    capabilities.push({
      id: `${pkg.id}:skills-${name}`,
      packageId: pkg.id,
      name,
      kind: "skill",
      path,
      description: descriptionFromBody(body),
      metadata: { body },
      hooks: [],
    });
  }
  for (const name of await safeReaddir(join(pkg.path, "agents"))) {
    const path = join(pkg.path, "agents", name);
    const body = await readFile(join(path, "AGENT.md"), "utf8");
    capabilities.push({
      id: `${pkg.id}:agents-${name}`,
      packageId: pkg.id,
      name,
      kind: "agent",
      path,
      description: descriptionFromBody(body),
      metadata: { body },
      hooks: [],
    });
  }
  for (const name of await safeReaddir(join(pkg.path, "mcp"))) {
    const path = join(pkg.path, "mcp", name, "mcp.json");
    const server = await readMcpServerConfig(path, name);
    capabilities.push({
      id: `${pkg.id}:mcp-${name}`,
      packageId: pkg.id,
      name,
      kind: "mcp",
      path,
      serverName: server.name,
      config: server.config,
      sourceFormat: server.sourceFormat,
      transport: server.transport,
      metadata: server.metadata ?? {},
    });
  }
  return capabilities;
}

function descriptionFromBody(body: string): string | undefined {
  const lines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !line.startsWith("#")) ?? lines[0]?.replace(/^#+\s*/u, "");
}

async function rejectEscapedCapabilityPath(sourceRoot: string, sourcePath: string): Promise<void> {
  const [resolvedRoot, resolvedTarget] = await Promise.all([
    realpath(sourceRoot),
    realpath(sourcePath),
  ]);
  const pathFromRoot = relative(resolvedRoot, resolvedTarget);
  if (
    pathFromRoot === ".." ||
    pathFromRoot.startsWith("../") ||
    pathFromRoot.startsWith("..\\") ||
    isAbsolute(pathFromRoot)
  ) {
    throw new Error(`Capability path escapes package source: ${sourcePath}`);
  }
}

async function readCapabilityDescription(
  kind: string,
  sourcePath: string
): Promise<string | undefined> {
  if (kind !== "agent" && kind !== "skill") {
    return undefined;
  }
  try {
    const lines = (await readFile(sourcePath, "utf8"))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.find((line) => !line.startsWith("#")) ?? lines[0]?.replace(/^#+\s*/u, "");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function getCapability(options: CapabilityIdOptions): Promise<IndexedCapability> {
  const found = (await listCapabilities(options)).find(
    (capability) => capability.id === options.id
  );
  if (!found) {
    throw new Error(`Capability not found: ${options.id}`);
  }
  return found;
}

function isOldSkillIndex(value: unknown): value is SkillIndex {
  return (
    typeof value === "object" && value !== null && "skills" in value && !("capabilities" in value)
  );
}

function sortedCapabilities<T extends IndexedCapability>(capabilities: T[]): T[] {
  return sortById(capabilities);
}

function sortById<T extends { id: string }>(values: T[]): T[] {
  return [...values].sort((a, b) => a.id.localeCompare(b.id));
}

function validateRecipeCapabilityPath(path: string): void {
  if (isAbsolute(path) || path.split("/").includes("..") || path.split("\\").includes("..")) {
    throw new Error(`Invalid recipe capability path: ${path}`);
  }
}

function validateRecipeCapabilityEntry(entry: string): void {
  if (entry.includes("/") || entry.includes("\\") || entry === "..") {
    throw new Error(`Invalid recipe capability entry: ${entry}`);
  }
}

async function resolveCapabilitySourcePath(options: {
  sourceRoot: string;
  kind: string;
  path: string;
  entry?: string;
}): Promise<{ indexPath: string; entryPath: string }> {
  const sourcePath = join(options.sourceRoot, options.path);
  if (await isFile(sourcePath)) {
    if (options.entry) {
      throw new Error(
        `Capability entry must be omitted when path points to a file: ${options.path}`
      );
    }
    return {
      indexPath: indexedFileCapabilityPath(options.kind, sourcePath),
      entryPath: sourcePath,
    };
  }

  const entry = options.entry ?? (await defaultCapabilityEntry(options.kind, sourcePath));
  const entryPath = join(sourcePath, entry);
  return { indexPath: options.kind === "mcp" ? entryPath : sourcePath, entryPath };
}

function indexedFileCapabilityPath(kind: string, sourcePath: string): string {
  if (
    (kind === "skill" && sourcePath.endsWith("/SKILL.md")) ||
    (kind === "agent" && (sourcePath.endsWith("/AGENT.md") || sourcePath.endsWith("/agent.md")))
  ) {
    return dirname(sourcePath);
  }
  return sourcePath;
}

async function defaultCapabilityEntry(kind: string, sourcePath: string): Promise<string> {
  if (kind === "skill") {
    return "SKILL.md";
  }
  if (kind === "agent") {
    return (await exists(join(sourcePath, "AGENT.md"))) ? "AGENT.md" : "agent.md";
  }
  return (await exists(join(sourcePath, "mcp.json"))) ? "mcp.json" : ".mcp.json";
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path)).isFile();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function generatedCapabilityAsIndexed(
  capability: GeneratedCapability
): Promise<IndexedCapability> {
  const name = capabilityName(capability);
  const metadata =
    capability.kind === "skill" || capability.kind === "agent"
      ? { body: await readGeneratedMarkdownBody(capability) }
      : {};
  const base = {
    id: capability.id,
    packageId: capability.package,
    name,
    kind: capability.kind,
    ...(capability.path ? { path: capability.path } : {}),
    ...(capability.description ? { description: capability.description } : {}),
    metadata,
    registry: capability.registry,
    formula: capability.formula,
    package: capability.package,
  };
  if (capability.kind === "skill" || capability.kind === "agent") {
    return { ...base, hooks: capability.hooks ?? [] } as IndexedCapability;
  }
  if (!capability.path) {
    return {
      ...base,
      serverName: capability.serverName,
      config: capability.config,
      sourceFormat: capability.sourceFormat,
      transport: capability.transport,
    } as IndexedCapability;
  }
  const server = await readMcpServerConfig(capability.path, name);
  return {
    ...base,
    serverName: server.name,
    config: server.config,
    sourceFormat: server.sourceFormat,
    transport: server.transport,
    metadata: { ...metadata, ...server.metadata },
  } as IndexedCapability;
}

function formulaHooksForCapability(
  recipe: RecipeLock,
  formulaCapabilityId: string,
  sourceRoot: string
): IndexedHookAttachment[] {
  const hooks: IndexedHookAttachment[] = [];
  for (const hook of recipe.hooks.entries) {
    if (
      !hook.appliesTo.includes(`skill:${formulaCapabilityId}`) &&
      !hook.appliesTo.includes(`agent:${formulaCapabilityId}`)
    )
      continue;
    for (const file of hook.files) {
      hooks.push({
        id: hook.id,
        packageId: recipe.id,
        ...(hook.description ? { description: hook.description } : {}),
        tool: file.target,
        file: join(sourceRoot, file.path),
        required: hook.required,
        appliesTo: hook.appliesTo,
      });
    }
  }
  return hooks;
}

async function readGeneratedMarkdownBody(capability: GeneratedCapability): Promise<string> {
  if (!capability.path)
    throw new Error(`Generated markdown capability requires path: ${capability.id}`);
  const fileName =
    capability.kind === "agent" && (await exists(join(capability.path, "agent.md")))
      ? "agent.md"
      : capability.kind === "agent"
        ? "AGENT.md"
        : "SKILL.md";
  const filePath = capability.path.endsWith(".md")
    ? capability.path
    : join(capability.path, fileName);
  return readFile(filePath, "utf8");
}

function capabilityName(capability: GeneratedCapability): string {
  if (capability.kind === "skill" || capability.kind === "agent") {
    if (!capability.path) return capability.id;
    return basename(capability.path.endsWith(".md") ? dirname(capability.path) : capability.path);
  }
  if (capability.serverName) return capability.serverName;
  const segment = capability.id.split(":").at(-1);
  return segment && segment.length > 0 ? segment : (capability.description ?? capability.id);
}

type McpSourceFormat = "claude-local" | "opencode" | "claude-api" | "direct";
type McpTransport = "stdio" | "remote";

interface ParsedMcpServerConfig {
  name: string;
  config: Record<string, unknown>;
  sourceFormat: McpSourceFormat;
  transport: McpTransport;
  metadata?: Record<string, unknown>;
}

async function readMcpServerConfig(
  path: string,
  fallbackName: string
): Promise<ParsedMcpServerConfig> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRecord(value)) {
    throw new Error(`Invalid MCP config: ${path}`);
  }
  if (isRecord(value.mcpServers)) {
    const [name, config] = singleServerEntry(value.mcpServers, path);
    return { name, config, sourceFormat: "claude-local", transport: transportFromDirect(config) };
  }
  if (isRecord(value.mcp)) {
    const [name, config] = singleServerEntry(value.mcp, path);
    return {
      name,
      config,
      sourceFormat: "opencode",
      transport: config.type === "remote" ? "remote" : "stdio",
    };
  }
  if (Array.isArray(value.mcp_servers)) {
    if (value.mcp_servers.length !== 1) {
      throw new Error(`MCP config must contain exactly one server: ${path}`);
    }
    const [config] = value.mcp_servers;
    if (!isRecord(config) || typeof config.name !== "string" || config.name.length === 0) {
      throw new Error(`Invalid MCP server config: ${path}`);
    }
    return {
      name: config.name,
      config,
      sourceFormat: "claude-api",
      transport: "remote",
      metadata: { claudeToolset: claudeApiToolsetForServer(value.tools, config.name, path) },
    };
  }
  if (!hasServerShape(value)) {
    const [name, config] = singleServerEntry(value, path);
    return { name, config, sourceFormat: "direct", transport: transportFromDirect(config) };
  }
  return {
    name: fallbackName,
    config: value,
    sourceFormat: "direct",
    transport: transportFromDirect(value),
  };
}

function singleServerEntry(
  value: Record<string, unknown>,
  path: string
): [string, Record<string, unknown>] {
  const entries = Object.entries(value);
  if (entries.length !== 1) {
    throw new Error(`MCP config must contain exactly one server: ${path}`);
  }
  const [name, config] = entries[0];
  if (!isRecord(config)) {
    throw new Error(`Invalid MCP server config: ${path}`);
  }
  return [name, config];
}

function claudeApiToolsetForServer(
  tools: unknown,
  name: string,
  path: string
): Record<string, unknown> {
  const toolsets = Array.isArray(tools)
    ? tools.filter(
        (tool): tool is Record<string, unknown> => isRecord(tool) && tool.type === "mcp_toolset"
      )
    : [];
  if (toolsets.length !== 1 || toolsets[0].mcp_server_name !== name) {
    throw new Error(
      `Claude API MCP config must contain exactly one toolset for server ${name}: ${path}`
    );
  }
  return toolsets[0];
}

function transportFromDirect(config: Record<string, unknown>): McpTransport {
  return config.type === "remote" ||
    config.type === "url" ||
    config.type === "http" ||
    config.type === "sse"
    ? "remote"
    : "stdio";
}

function hasServerShape(config: Record<string, unknown>): boolean {
  return (
    typeof config.type === "string" ||
    typeof config.command === "string" ||
    typeof config.url === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function safeReaddir(path: string): Promise<string[]>;
async function safeReaddir(
  path: string,
  options: { withFileTypes: true }
): Promise<import("node:fs").Dirent[]>;
async function safeReaddir(
  path: string,
  options?: { withFileTypes: true }
): Promise<string[] | import("node:fs").Dirent[]> {
  try {
    return options ? await readdir(path, options) : await readdir(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
