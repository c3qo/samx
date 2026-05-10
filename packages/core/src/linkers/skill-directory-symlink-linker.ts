import { basename, dirname, join, resolve } from "node:path";

import type { LinkedAgent, LinkedSkill, LinkPlan } from "./types.js";

export interface SkillDirectorySymlinkOptions {
  tool: string;
  root: string;
  displayName?: string;
  label?: string;
}

export function createDirectorySymlinkLinkPlan(
  bundleId: string,
  inputProjectRoot: string,
  capabilities: Array<LinkedSkill | LinkedAgent>,
  options: SkillDirectorySymlinkOptions
): LinkPlan {
  const projectRoot = resolve(inputProjectRoot);
  const generatedFiles = new Set<string>();
  const symlinks = capabilities.map((capability) => {
    const path = join(
      projectRoot,
      options.root,
      safeCapabilityDirectory(capability.linkAlias ?? capability.id)
    );
    if (generatedFiles.has(path)) {
      throw new Error(
        `${options.displayName ?? options.tool} ${options.label ?? "capability"} output path collision: ${path}`
      );
    }
    generatedFiles.add(path);
    return { path, target: resolve(capabilityDirectory(capability.path)) };
  });

  return {
    tool: options.tool,
    bundleId,
    projectRoot,
    generatedFiles: symlinks.map((link) => link.path),
    files: [],
    symlinks,
    jsonMerges: [],
    instructionBlocks: [],
    tomlMerges: [],
    hooks: [],
    skippedHooks: [],
    hookWarnings: [],
    environmentReminders: [],
    advisories: [],
    hookCandidates: [],
    hookDecisionRequired: false,
    enabledAdjacentHooks: [],
  };
}

function capabilityDirectory(path: string): string {
  const name = basename(path);
  return name === "SKILL.md" || name === "AGENT.md" ? dirname(path) : path;
}

function safeCapabilityDirectory(capabilityId: string): string {
  const safe = capabilityId
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return safe.length > 0 ? safe : "capability";
}
