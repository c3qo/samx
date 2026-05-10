import type { HookTarget, IndexedMcp, SamxPackage } from "@c3qo/samx-schemas";

import { getBundle } from "../bundles/store.js";
import { readCapabilityIndex } from "../capabilities/index.js";
import { loadBuiltinConfigRegistry } from "../config/loader.js";
import { createDirectorySymlinkLinkPlan } from "../linkers/skill-directory-symlink-linker.js";
import type {
  LinkedAgent,
  LinkedCapability,
  LinkedSkill,
  LinkPlan,
  LinkPlanHook,
  LinkPlanInstructionBlock,
  LinkPlanJsonMerge,
  LinkPlanSymlink,
  LinkPlanTomlMerge,
} from "../linkers/types.js";
import type {
  AdjacentHookAppliesTo,
  AdjacentHookCandidate,
  TopLevelOpenCodeHookCandidate,
} from "../packages/hook-candidates.js";
import {
  discoverAdjacentHookCandidates,
  discoverTopLevelOpenCodeHookCandidates,
  filterAdjacentHookCandidates,
} from "../packages/hook-candidates.js";
import { listPackages } from "../packages/store.js";
import {
  annotateClaudeHooks,
  claudeHookDrift,
  fingerprintFile,
  fingerprintJson,
  hookExtensionAllowed,
} from "./hooks.js";
import { displayLinkTarget, getCapabilityLinkTargetRule, getLinkTargetConfig } from "./targets.js";
import { readJsonFile } from "../store/atomic.js";
import { samxPaths } from "../store/paths.js";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

export type AdjacentHookDecision =
  | { mode: "unspecified" }
  | { mode: "none" }
  | { mode: "all" }
  | { mode: "selected"; ids: string[] };

interface PreviousAdjacentHookRecord {
  id: string;
  packageId: string;
  tool: HookTarget;
  sourcePath: string;
  fingerprint: string;
}

interface PreviousLinkRecordWithAdjacentHooks {
  adjacentHooks: PreviousAdjacentHookRecord[];
}

export interface PlanBundleLinkOptions {
  samxHome?: string;
  bundleId: string;
  tool: string;
  projectRoot: string;
  adjacentHooks?: AdjacentHookDecision;
}

export async function planBundleLink(options: PlanBundleLinkOptions): Promise<LinkPlan> {
  const registry = await loadBuiltinConfigRegistry();
  const target = getLinkTargetConfig(registry, options.tool);

  const bundle = await getBundle({ samxHome: options.samxHome, id: options.bundleId });
  const index = await readCapabilityIndex({ samxHome: options.samxHome });
  const capabilitiesById = new Map(
    index.capabilities.map((capability) => [capability.id, capability])
  );
  const skills: LinkedSkill[] = [];
  const agents: LinkedAgent[] = [];
  const mcpCapabilities: LinkedCapability[] = [];
  const bundleRefsByPackage = new Map<string, Set<AdjacentHookAppliesTo>>();
  const selectedRefsByPackage = new Map<string, AdjacentHookAppliesTo[]>();
  const selectedPackages = new Set<string>();

  for (const item of bundle.items) {
    const capability = capabilitiesById.get(item.id);
    if (!capability) {
      throw new Error(`Bundle item not found in capability index: ${item.id}`);
    }
    if (capability.kind !== item.kind) {
      throw new Error(
        `Bundle item kind mismatch for ${item.id}: bundle has ${item.kind}, index has ${capability.kind}`
      );
    }
    if (!handledByInstructions(target, capability.kind)) {
      getCapabilityLinkTargetRule(target, capability.kind);
    }
    const linked = { ...capability, ...(item.alias ? { linkAlias: item.alias } : {}) };
    selectedPackages.add(linked.packageId);
    if (linked.kind === "skill") skills.push(linked);
    if (linked.kind === "agent") agents.push(linked);
    if (linked.kind === "mcp") mcpCapabilities.push(linked);
    if (linked.kind === "skill" || linked.kind === "agent") {
      const packageRefs =
        bundleRefsByPackage.get(linked.packageId) ?? new Set<AdjacentHookAppliesTo>();
      const ref = `${linked.kind}:${linked.name}` as AdjacentHookAppliesTo;
      packageRefs.add(ref);
      bundleRefsByPackage.set(linked.packageId, packageRefs);
      selectedRefsByPackage.set(linked.packageId, [
        ...(selectedRefsByPackage.get(linked.packageId) ?? []),
        ref,
      ]);
    }
  }

  const symlinks: LinkPlanSymlink[] = [];
  const jsonMerges: LinkPlanJsonMerge[] = [];
  const instructionBlocks: LinkPlanInstructionBlock[] = [];
  const tomlMerges: LinkPlanTomlMerge[] = [];
  const hooks: LinkPlanHook[] = [];
  const generatedFiles: string[] = [];
  const projectRoot = resolve(options.projectRoot);

  const skillRule = target.capabilities.skill;
  if (skills.length > 0 && skillRule?.mode === "directory-symlink") {
    const plan = createDirectorySymlinkLinkPlan(bundle.id, projectRoot, skills, {
      tool: options.tool,
      root: skillRule.root,
      displayName: displayLinkTarget(options.tool, target),
      label: "skill",
    });
    symlinks.push(...plan.symlinks);
    generatedFiles.push(...plan.generatedFiles);
  }

  const agentRule = target.capabilities.agent;
  if (agents.length > 0 && agentRule?.mode === "directory-symlink") {
    const plan = createDirectorySymlinkLinkPlan(bundle.id, projectRoot, agents, {
      tool: options.tool,
      root: agentRule.root,
      displayName: displayLinkTarget(options.tool, target),
      label: "agent",
    });
    symlinks.push(...plan.symlinks);
    generatedFiles.push(...plan.generatedFiles);
  }

  const instructionCapabilities = instructionBlockCapabilities(target, skills, agents);
  if (instructionCapabilities.length > 0 && target.instructions?.mode === "agents-md-section") {
    const path = join(projectRoot, target.instructions.output);
    instructionBlocks.push({
      path,
      marker: { bundleId: bundle.id, tool: options.tool },
      content: renderInstructionBlock(bundle.id, instructionCapabilities),
    });
  }

  const mcpRule = target.capabilities.mcp;
  if (mcpCapabilities.length > 0 && mcpRule?.mode === "mcp-json-merge") {
    const path = join(projectRoot, mcpRule.output);
    const seenServers = new Set<string>();
    jsonMerges.push({
      path,
      keyPath: mcpRule.keyPath ?? ["mcpServers"],
      ...(mcpRule.defaults ? { defaults: mcpRule.defaults } : {}),
      entries: mcpCapabilities.map((capability) => {
        if (capability.kind !== "mcp")
          throw new Error(`Unexpected non-MCP capability: ${capability.id}`);
        const outputKey =
          options.tool === "opencode" || options.tool === "claude"
            ? scopedMcpServerKey(capability.packageId, capability.name)
            : capability.serverName;
        if (seenServers.has(outputKey)) {
          throw new Error(
            `${displayLinkTarget(options.tool, target)} MCP server output collision: ${outputKey}`
          );
        }
        seenServers.add(outputKey);
        return { key: outputKey, value: mcpConfigForTarget(capability, options.tool) };
      }),
    });
    generatedFiles.push(path);
  }
  if (mcpCapabilities.length > 0 && mcpRule?.mode === "mcp-toml-merge") {
    const path = join(projectRoot, mcpRule.output);
    const seenServers = new Set<string>();
    tomlMerges.push({
      path,
      tablePath: mcpRule.tablePath,
      entries: mcpCapabilities.map((capability) => {
        if (capability.kind !== "mcp")
          throw new Error(`Unexpected non-MCP capability: ${capability.id}`);
        const outputKey = capability.serverName;
        if (seenServers.has(outputKey)) {
          throw new Error(
            `${displayLinkTarget(options.tool, target)} MCP server output collision: ${outputKey}`
          );
        }
        seenServers.add(outputKey);
        return { key: outputKey, value: codexMcpConfigForTarget(capability) };
      }),
    });
  }

  const seenHooks = new Set<string>();
  const seenHookOutputs = new Set<string>();
  const skippedHooks: LinkPlan["skippedHooks"] = [];
  const packages = await listPackages({ samxHome: options.samxHome });
  const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const environmentReminders = [...selectedPackages]
    .map((packageId) => ({
      packageId,
      env: [...(packagesById.get(packageId)?.requirements?.env ?? [])].sort((left, right) =>
        left.localeCompare(right)
      ),
    }))
    .filter((reminder) => reminder.env.length > 0)
    .sort((left, right) => left.packageId.localeCompare(right.packageId));
  const advisories = [...selectedPackages]
    .flatMap((packageId) =>
      (packagesById.get(packageId)?.advisories ?? []).map((advisory) => ({
        packageId,
        ...advisory,
      }))
    )
    .sort((left, right) =>
      `${left.packageId}:${left.id}`.localeCompare(`${right.packageId}:${right.id}`)
    );
  const disableOpencodeHooks =
    options.tool === "opencode" &&
    target.hooks?.mode === "opencode-plugin" &&
    (options.adjacentHooks?.mode ?? "unspecified") === "none";
  const hookWarnings: string[] = [];
  for (const hook of [...skills, ...agents].flatMap((capability) => capability.hooks)) {
    const dedupeKey = `${hook.packageId}:${hook.id}:${target.hooks ? hook.tool : options.tool}`;
    if (seenHooks.has(dedupeKey)) continue;
    seenHooks.add(dedupeKey);

    if (options.tool === "codex") continue;

    if (!target.hooks) {
      if (hook.required)
        throw new Error(`Required hook target unsupported: ${hook.id} (${options.tool})`);
      continue;
    }

    if (hook.tool !== options.tool) continue;

    if (disableOpencodeHooks && hook.tool === "opencode") {
      skippedHooks.push({
        id: hook.id,
        packageId: hook.packageId,
        relativeFile: relativePackageHookFile(hook.file),
        inference: "top-level",
        reason: "--no-hooks",
      });
      continue;
    }

    if (target.hooks?.mode === "claude-settings-hooks" && hook.tool === "claude") {
      assertHookExtensionAllowed("Claude", hook.id, hook.file, target.hooks.allowedExtensions);
      const parsed = JSON.parse(await readHookSource(hook)) as unknown;
      const preview = annotateClaudeHooks(parsed, {
        packageId: hook.packageId,
        hookId: hook.id,
        bundleId: bundle.id,
        tool: hook.tool,
      });
      const settingsPath = join(projectRoot, target.hooks.settings);
      const drift = await claudeHookDrift(settingsPath, preview);
      hooks.push({
        id: hook.id,
        packageId: hook.packageId,
        kind: "jsonMerge",
        tool: hook.tool,
        ...(hook.description ? { description: hook.description } : {}),
        sourcePath: hook.file,
        settingsPath,
        required: hook.required,
        appliesTo: hook.appliesTo,
        fingerprint: fingerprintJson(preview),
        ...(drift.length > 0 ? { drift } : {}),
        preview,
      });
      generatedFiles.push(settingsPath);
    }

    if (target.hooks?.mode === "opencode-plugin" && hook.tool === "opencode") {
      assertHookExtensionAllowed("OpenCode", hook.id, hook.file, target.hooks.allowedExtensions);
      const outputPath = join(
        projectRoot,
        target.hooks.root,
        `${safeHookOutputName(hook.packageId, hook.id)}${extname(hook.file)}`
      );
      if (seenHookOutputs.has(outputPath)) {
        throw new Error(`OpenCode hook output path collision: ${outputPath}`);
      }
      seenHookOutputs.add(outputPath);
      hooks.push({
        id: hook.id,
        packageId: hook.packageId,
        kind: "symlink",
        tool: hook.tool,
        ...(hook.description ? { description: hook.description } : {}),
        sourcePath: hook.file,
        outputPath,
        required: hook.required,
        appliesTo: hook.appliesTo,
        fingerprint: await fingerprintHookSource(hook),
        preview: { file: hook.file },
      });
      generatedFiles.push(outputPath);
    }
  }

  const hookCandidates = target.hooks
    ? (
        await relevantAdjacentHookCandidates(options.samxHome, bundleRefsByPackage, options.tool)
      ).filter(
        (candidate) =>
          !seenHooks.has(adjacentHookDedupeKey(candidate.packageId, candidate.id, candidate.tool))
      )
    : [];
  const topLevelHookCandidates =
    options.tool === "opencode"
      ? await relevantTopLevelOpenCodeHookCandidates(packages, selectedRefsByPackage)
      : [];
  const mcpOnlyTopLevelHookCandidates =
    options.tool === "opencode"
      ? await mcpOnlyTopLevelOpenCodeHookCandidates(
          packages,
          selectedRefsByPackage,
          selectedPackages
        )
      : [];
  const opencodeAutoHooks =
    options.tool === "opencode" &&
    target.hooks?.mode === "opencode-plugin" &&
    (options.adjacentHooks?.mode ?? "unspecified") !== "none";
  skippedHooks.push(
    ...(disableOpencodeHooks
      ? [
          ...topLevelHookCandidates.map((candidate) => ({
            id: candidate.id,
            packageId: candidate.packageId,
            relativeFile: candidate.relativeFile,
            inference: "top-level" as const,
            reason: "--no-hooks" as const,
          })),
          ...hookCandidates.map((candidate) => ({
            id: candidate.id,
            packageId: candidate.packageId,
            relativeFile: candidate.relativeFile,
            inference: "adjacent" as const,
            reason: "--no-hooks" as const,
          })),
        ]
      : [])
  );
  if (options.tool === "opencode") {
    hookWarnings.push(
      ...mcpOnlyTopLevelHookCandidates.map(
        (candidate) =>
          `Top-level hook skipped: ${candidate.relativeFile} (no selected skill or agent capability from package ${candidate.packageId})`
      )
    );
  }
  if (opencodeAutoHooks) {
    const hookRoot = target.hooks?.mode === "opencode-plugin" ? target.hooks.root : undefined;
    if (!hookRoot) throw new Error("OpenCode hook target missing plugin root");
    for (const candidate of topLevelHookCandidates) {
      const dedupeKey = adjacentHookDedupeKey(candidate.packageId, candidate.id, candidate.tool);
      if (seenHooks.has(dedupeKey)) continue;
      seenHooks.add(dedupeKey);
      const outputPath = join(
        projectRoot,
        hookRoot,
        `${safeHookOutputName(candidate.packageId, candidate.id)}${extname(candidate.file)}`
      );
      if (seenHookOutputs.has(outputPath))
        throw new Error(`OpenCode hook output path collision: ${outputPath}`);
      seenHookOutputs.add(outputPath);
      hooks.push({
        id: candidate.id,
        packageId: candidate.packageId,
        kind: "symlink",
        tool: candidate.tool,
        sourcePath: candidate.file,
        outputPath,
        required: false,
        appliesTo: selectedRefsByPackage.get(candidate.packageId) ?? [],
        fingerprint: candidate.fingerprint,
        inference: "top-level",
        preview: { file: candidate.file },
      });
      generatedFiles.push(outputPath);
    }
  }
  const previousRecord = await readPreviousLinkRecordWithAdjacentHooks(
    options.samxHome,
    linkRecordId(bundle.id, options.tool, projectRoot)
  );
  const reusePrevious = canReusePreviousAdjacentHooks(hookCandidates, previousRecord);
  const adjacentDecision = options.adjacentHooks ?? { mode: "unspecified" };
  const hookDecisionRequired =
    options.tool === "opencode"
      ? false
      : hookCandidates.length > 0 && adjacentDecision.mode === "unspecified" && !reusePrevious;
  const enabledAdjacentHooks = opencodeAutoHooks
    ? hookCandidates
    : selectAdjacentHooks(
        hookCandidates,
        adjacentDecision,
        reusePrevious ? previousRecord : undefined
      );
  const plannedAdjacentHooks: AdjacentHookCandidate[] = [];

  for (const candidate of enabledAdjacentHooks) {
    if (!target.hooks) continue;
    const dedupeKey = adjacentHookDedupeKey(candidate.packageId, candidate.id, candidate.tool);
    if (seenHooks.has(dedupeKey)) continue;
    seenHooks.add(dedupeKey);

    if (target.hooks.mode === "claude-settings-hooks" && candidate.tool === "claude") {
      assertHookExtensionAllowed(
        "Claude",
        candidate.id,
        candidate.file,
        target.hooks.allowedExtensions
      );
      const parsed = JSON.parse(await readAdjacentHookSource(candidate)) as unknown;
      const preview = annotateClaudeHooks(parsed, {
        packageId: candidate.packageId,
        hookId: candidate.id,
        bundleId: bundle.id,
        tool: candidate.tool,
      });
      const settingsPath = join(projectRoot, target.hooks.settings);
      const drift = await claudeHookDrift(settingsPath, preview);
      hooks.push({
        id: candidate.id,
        packageId: candidate.packageId,
        kind: "jsonMerge",
        tool: candidate.tool,
        sourcePath: candidate.file,
        settingsPath,
        required: false,
        appliesTo: candidate.appliesTo,
        fingerprint: fingerprintJson(preview),
        ...(drift.length > 0 ? { drift } : {}),
        preview,
      });
      plannedAdjacentHooks.push(candidate);
      generatedFiles.push(settingsPath);
    }

    if (target.hooks.mode === "opencode-plugin" && candidate.tool === "opencode") {
      assertHookExtensionAllowed(
        "OpenCode",
        candidate.id,
        candidate.file,
        target.hooks.allowedExtensions
      );
      const outputPath = join(
        projectRoot,
        target.hooks.root,
        `${safeHookOutputName(candidate.packageId, candidate.id)}${extname(candidate.file)}`
      );
      if (seenHookOutputs.has(outputPath)) {
        throw new Error(`OpenCode hook output path collision: ${outputPath}`);
      }
      seenHookOutputs.add(outputPath);
      hooks.push({
        id: candidate.id,
        packageId: candidate.packageId,
        kind: "symlink",
        tool: candidate.tool,
        sourcePath: candidate.file,
        outputPath,
        required: false,
        appliesTo: candidate.appliesTo,
        fingerprint: await fingerprintAdjacentHookSource(candidate),
        inference: "adjacent",
        preview: { file: candidate.file },
      });
      plannedAdjacentHooks.push(candidate);
      generatedFiles.push(outputPath);
    }
  }

  return {
    tool: options.tool,
    bundleId: bundle.id,
    projectRoot,
    generatedFiles: [...new Set(generatedFiles)],
    files: [],
    symlinks,
    jsonMerges,
    instructionBlocks,
    tomlMerges,
    hooks,
    skippedHooks,
    hookWarnings,
    environmentReminders,
    advisories,
    hookCandidates: opencodeAutoHooks ? [] : hookCandidates,
    hookDecisionRequired,
    enabledAdjacentHooks: opencodeAutoHooks ? [] : plannedAdjacentHooks,
  };
}

function instructionBlockCapabilities(
  target: { instructions?: { mode: string; kinds?: Array<"skill" | "agent"> } },
  skills: LinkedSkill[],
  agents: LinkedAgent[]
): Array<LinkedSkill | LinkedAgent> {
  if (target.instructions?.mode !== "agents-md-section") return [];
  const kinds = target.instructions.kinds ?? ["skill", "agent"];
  return [...(kinds.includes("skill") ? skills : []), ...(kinds.includes("agent") ? agents : [])];
}

function handledByInstructions(
  target: { instructions?: { mode: string; kinds?: Array<"skill" | "agent"> } },
  kind: string
): boolean {
  if (target.instructions?.mode !== "agents-md-section") return false;
  const kinds = target.instructions.kinds ?? ["skill", "agent"];
  return (kind === "skill" || kind === "agent") && kinds.includes(kind);
}

function renderInstructionBlock(
  bundleId: string,
  capabilities: Array<LinkedSkill | LinkedAgent>
): string {
  const lines = [`# SAMX Bundle: ${bundleId}`, ""];
  for (const capability of capabilities) {
    lines.push(
      `## ${capability.kind}: ${capability.name}`,
      capability.description ?? capability.id,
      ""
    );
  }
  return lines.join("\n").trimEnd() + "\n";
}

function scopedMcpServerKey(packageId: string, name: string): string {
  const packageScope = packageId.replace(/^default\//u, "");
  const capabilityName = name.replace(/^mcp-/u, "");
  const packageName = packageScope.split("/").filter(Boolean).at(-1);
  return slugMcpKey(
    packageName === capabilityName ? packageScope : `${packageScope}-${capabilityName}`
  );
}

function slugMcpKey(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
}

function mcpConfigForTarget(capability: IndexedMcp, tool: string): Record<string, unknown> {
  const config = normalizedLegacyMcpConfig(capability.config);
  const sourceFormat = capability.sourceFormat ?? inferMcpSourceFormat(config);
  const transport = capability.transport ?? inferMcpTransport(config);
  if (tool === "opencode") {
    if (sourceFormat === "opencode") return validateOpenCodeMcpServer(config);
    if (sourceFormat === "claude-api") return claudeApiToOpenCodeRemote(config);
    if (transport === "remote") return remoteMcpToOpenCodeRemote(config);
    return claudeLocalToOpenCodeLocal(validateClaudeLocalMcpServer(config));
  }

  if (tool === "claude") {
    if (transport === "remote" || sourceFormat === "claude-api")
      return remoteMcpToClaudeHttp(config);
    if (sourceFormat === "opencode")
      return opencodeLocalToClaudeLocal(validateOpenCodeMcpServer(config));
    return validateClaudeLocalMcpServer(config);
  }

  if (tool === "kiro") {
    if (transport === "remote" || sourceFormat === "claude-api") {
      throw new Error(
        `Unsupported MCP transform for ${tool}: remote servers cannot be linked to ${tool}`
      );
    }
    if (sourceFormat === "opencode")
      return opencodeLocalToClaudeLocal(validateOpenCodeMcpServer(config));
    return validateClaudeLocalMcpServer(config);
  }

  return config;
}

function codexMcpConfigForTarget(capability: IndexedMcp): Record<string, unknown> {
  const config = normalizedLegacyMcpConfig(capability.config);
  const sourceFormat = capability.sourceFormat ?? inferMcpSourceFormat(config);
  const transport = capability.transport ?? inferMcpTransport(config);
  if (transport === "remote" || sourceFormat === "claude-api") {
    if (typeof config.url !== "string")
      throw new Error("Invalid Codex remote MCP server: url must be a string");
    assertRemoteMcpHttpsUrl(config.url);
    const token =
      typeof config.authorization_token === "string"
        ? config.authorization_token.match(/^\$\{([A-Z0-9_]+)\}$/u)?.[1]
        : undefined;
    return validateCodexTomlMcpConfig({
      url: config.url,
      ...(token ? { bearer_token_env_var: token } : {}),
    });
  }
  const local =
    sourceFormat === "opencode"
      ? opencodeLocalToClaudeLocal(validateOpenCodeMcpServer(config))
      : validateClaudeLocalMcpServer(config);
  return validateCodexTomlMcpConfig({
    command: local.command,
    ...(isStringArray(local.args) ? { args: local.args } : {}),
    ...(isRecord(local.env) ? { env: local.env } : {}),
  });
}

function validateCodexTomlMcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number")
      continue;
    if (isStringArray(value)) continue;
    if (
      isRecord(value) &&
      Object.values(value).every(
        (entry) =>
          typeof entry === "string" || typeof entry === "boolean" || typeof entry === "number"
      )
    )
      continue;
    throw new Error(`Unsupported Codex MCP TOML config value for key ${key}`);
  }
  return config;
}

function inferMcpSourceFormat(config: Record<string, unknown>): IndexedMcp["sourceFormat"] {
  if (config.type === "local" || config.type === "remote") return "opencode";
  if (config.type === "url") return "claude-api";
  if (config.type === "http" || config.type === "sse") return "direct";
  if (typeof config.command === "string") return "claude-local";
  return "claude-local";
}

function inferMcpTransport(config: Record<string, unknown>): IndexedMcp["transport"] {
  return config.type === "remote" ||
    config.type === "url" ||
    config.type === "http" ||
    config.type === "sse"
    ? "remote"
    : "stdio";
}

function normalizedLegacyMcpConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(config.mcpServers)) return singleLegacyMcpServer(config.mcpServers) ?? config;
  if (isRecord(config.mcp)) return singleLegacyMcpServer(config.mcp) ?? config;
  if (!hasServerShape(config)) return singleLegacyMcpServer(config) ?? config;
  return config;
}

function singleLegacyMcpServer(
  config: Record<string, unknown>
): Record<string, unknown> | undefined {
  const entries = Object.entries(config);
  if (entries.length !== 1) return undefined;
  const [, server] = entries[0];
  return isRecord(server) ? server : undefined;
}

function hasServerShape(config: Record<string, unknown>): boolean {
  return (
    typeof config.type === "string" ||
    typeof config.command === "string" ||
    typeof config.url === "string"
  );
}

function validateClaudeLocalMcpServer(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.command !== "string")
    throw new Error("Invalid Claude local MCP server: command must be a string");
  return config;
}

function validateOpenCodeMcpServer(config: Record<string, unknown>): Record<string, unknown> {
  if (config.type === "local" && !isNonEmptyStringArray(config.command))
    throw new Error("Invalid OpenCode MCP server: local command must be string[]");
  return config;
}

function remoteMcpToOpenCodeRemote(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.url !== "string")
    throw new Error("Invalid OpenCode MCP server: remote type and url are required");
  assertRemoteMcpHttpsUrl(config.url);
  return {
    type: "remote",
    url: config.url,
    ...(isRecord(config.headers) ? { headers: config.headers } : {}),
    ...(typeof config.enabled === "boolean" ? { enabled: config.enabled } : {}),
  };
}

function remoteMcpToClaudeHttp(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.url !== "string")
    throw new Error("Invalid Claude remote MCP server: url must be a string");
  assertRemoteMcpHttpsUrl(config.url);
  return { type: "http", url: config.url };
}

function claudeLocalToOpenCodeLocal(config: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "local",
    command: [config.command, ...(isStringArray(config.args) ? config.args : [])],
    ...(isRecord(config.env) ? { environment: config.env } : {}),
  };
}

function opencodeLocalToClaudeLocal(config: Record<string, unknown>): Record<string, unknown> {
  if (config.type !== "local")
    throw new Error("Invalid OpenCode MCP server: local command must be string[]");
  const [command, ...args] = config.command as string[];
  return {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(isRecord(config.environment) ? { env: config.environment } : {}),
  };
}

function claudeApiToOpenCodeRemote(config: Record<string, unknown>): Record<string, unknown> {
  if (config.type !== "url" || typeof config.url !== "string")
    throw new Error("Invalid Claude API MCP server: type must be url and url must be a string");
  assertRemoteMcpHttpsUrl(config.url);
  return {
    type: "remote",
    url: config.url,
    enabled: true,
    ...(typeof config.authorization_token === "string"
      ? { headers: { Authorization: `Bearer ${config.authorization_token}` } }
      : {}),
  };
}

function assertRemoteMcpHttpsUrl(url: string): void {
  if (!url.startsWith("https://"))
    throw new Error("Invalid remote MCP URL: URL must start with https://");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0;
}

function relativePackageHookFile(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const marker = "/hooks/";
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

async function relevantTopLevelOpenCodeHookCandidates(
  packages: SamxPackage[],
  selectedRefsByPackage: Map<string, AdjacentHookAppliesTo[]>
): Promise<TopLevelOpenCodeHookCandidate[]> {
  return (
    await Promise.all(
      packages.map(async (pkg) => {
        if ((selectedRefsByPackage.get(pkg.id) ?? []).length === 0) return [];
        return discoverTopLevelOpenCodeHookCandidates(pkg);
      })
    )
  ).flat();
}

async function mcpOnlyTopLevelOpenCodeHookCandidates(
  packages: SamxPackage[],
  selectedRefsByPackage: Map<string, AdjacentHookAppliesTo[]>,
  selectedPackages: Set<string>
): Promise<TopLevelOpenCodeHookCandidate[]> {
  return (
    await Promise.all(
      packages.map(async (pkg) => {
        if (!selectedPackages.has(pkg.id) || (selectedRefsByPackage.get(pkg.id) ?? []).length > 0)
          return [];
        return discoverTopLevelOpenCodeHookCandidates(pkg);
      })
    )
  ).flat();
}

async function relevantAdjacentHookCandidates(
  samxHome: string | undefined,
  bundleRefsByPackage: Map<string, Set<AdjacentHookAppliesTo>>,
  tool: string
): Promise<AdjacentHookCandidate[]> {
  if (!isHookTarget(tool)) return [];
  return (
    await Promise.all(
      (await listPackages({ samxHome })).map(async (pkg) => {
        const packageRefs = bundleRefsByPackage.get(pkg.id);
        if (!packageRefs) return [];
        return filterAdjacentHookCandidates(await discoverAdjacentHookCandidates(pkg), {
          appliesTo: [...packageRefs],
          tool,
        });
      })
    )
  ).flat();
}

function selectAdjacentHooks(
  candidates: AdjacentHookCandidate[],
  decision: AdjacentHookDecision,
  previousRecord: PreviousLinkRecordWithAdjacentHooks | undefined
): AdjacentHookCandidate[] {
  if (decision.mode === "none") return [];
  if (decision.mode === "all") return candidates;
  if (decision.mode === "selected") {
    return decision.ids.map((id) => selectAdjacentHookById(candidates, id));
  }
  if (!previousRecord) return [];

  const recordKeys = new Set(previousRecord.adjacentHooks.map(adjacentHookRecordKey));
  return candidates.filter((candidate) => recordKeys.has(adjacentCandidateRecordKey(candidate)));
}

function adjacentHookDedupeKey(packageId: string, id: string, tool: string): string {
  return `${packageId}:${id}:${tool}`;
}

function selectAdjacentHookById(
  candidates: AdjacentHookCandidate[],
  id: string
): AdjacentHookCandidate {
  const matches = candidates.filter((candidate) => candidate.id === id);
  if (matches.length === 0) {
    throw new Error(`Adjacent hook selection not found: ${id}`);
  }
  if (matches.length > 1) {
    throw new Error(`Adjacent hook selection is ambiguous: ${id}`);
  }
  return matches[0] as AdjacentHookCandidate;
}

function canReusePreviousAdjacentHooks(
  candidates: AdjacentHookCandidate[],
  record: PreviousLinkRecordWithAdjacentHooks | undefined
): boolean {
  if (!record || record.adjacentHooks.length === 0) return false;
  const candidateKeys = candidates.map(adjacentCandidateRecordKey).sort();
  const recordKeys = record.adjacentHooks.map(adjacentHookRecordKey).sort();
  return (
    candidateKeys.length === recordKeys.length &&
    candidateKeys.every((key, index) => key === recordKeys[index])
  );
}

function adjacentCandidateRecordKey(candidate: AdjacentHookCandidate): string {
  return `${candidate.packageId}\0${candidate.id}\0${candidate.tool}\0${candidate.file}\0${candidate.fingerprint}`;
}

function adjacentHookRecordKey(record: PreviousAdjacentHookRecord): string {
  return `${record.packageId}\0${record.id}\0${record.tool}\0${record.sourcePath}\0${record.fingerprint}`;
}

async function readPreviousLinkRecordWithAdjacentHooks(
  samxHome: string | undefined,
  id: string
): Promise<PreviousLinkRecordWithAdjacentHooks | undefined> {
  const recordSet = await readJsonFile<{ links?: unknown[] }>(samxPaths(samxHome).linkRecords, {
    links: [],
  });
  const record = (recordSet.links ?? []).find((entry) => isRecord(entry) && entry.id === id);
  if (!isRecord(record)) return undefined;
  return {
    adjacentHooks: Array.isArray(record.adjacentHooks)
      ? record.adjacentHooks.filter(isPreviousAdjacentHookRecord)
      : [],
  };
}

function isPreviousAdjacentHookRecord(value: unknown): value is PreviousAdjacentHookRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.packageId === "string" &&
    (value.tool === "claude" || value.tool === "opencode") &&
    typeof value.sourcePath === "string" &&
    typeof value.fingerprint === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookTarget(tool: string): tool is HookTarget {
  return tool === "claude" || tool === "opencode";
}

function linkRecordId(bundleId: string, tool: string, projectRoot: string): string {
  return `${bundleId}:${tool}:${resolve(projectRoot)}`;
}

function assertHookExtensionAllowed(
  displayName: "Claude" | "OpenCode",
  id: string,
  path: string,
  allowedExtensions: string[]
): void {
  if (!hookExtensionAllowed(path, allowedExtensions)) {
    throw new Error(`${displayName} hook file extension is not allowed: ${id}`);
  }
}

function safeHookOutputName(packageId: string, hookId: string): string {
  return (
    `${packageId}-${hookId}`
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "") || "hook"
  );
}

async function readHookSource(hook: { id: string; tool: string; file: string }): Promise<string> {
  try {
    return await readFile(hook.file, "utf8");
  } catch {
    throw new Error(`Hook source file unreadable: ${hook.file}`);
  }
}

async function fingerprintHookSource(hook: {
  id: string;
  tool: string;
  file: string;
}): Promise<string> {
  try {
    return await fingerprintFile(hook.file);
  } catch {
    throw new Error(`Hook source file unreadable: ${hook.file}`);
  }
}

async function readAdjacentHookSource(candidate: AdjacentHookCandidate): Promise<string> {
  try {
    return await readFile(candidate.file, "utf8");
  } catch {
    throw new Error(`Hook source file unreadable: ${candidate.file}`);
  }
}

async function fingerprintAdjacentHookSource(candidate: AdjacentHookCandidate): Promise<string> {
  try {
    return await fingerprintFile(candidate.file);
  } catch {
    throw new Error(`Hook source file unreadable: ${candidate.file}`);
  }
}
