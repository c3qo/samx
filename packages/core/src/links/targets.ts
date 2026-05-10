import type { CapabilityLinkTargetRule, CapabilityType, LinkTargetConfig } from "@c3qo/samx-schemas";

import type { ConfigRegistry } from "../config/types.js";
import { loadBuiltinConfigRegistry } from "../config/loader.js";

export function getLinkTargetConfig(registry: ConfigRegistry, tool: string): LinkTargetConfig {
  const config = registry.linkTargets[tool];
  if (!config) {
    throw new Error(`Unsupported link target: ${tool}`);
  }
  assertSafeLinkTargetConfig(tool, config);
  return config;
}

export async function loadLinkTargetConfig(tool: string): Promise<LinkTargetConfig> {
  return getLinkTargetConfig(await loadBuiltinConfigRegistry(), tool);
}

export function displayLinkTarget(tool: string, config: LinkTargetConfig): string {
  return config.displayName ?? tool;
}

export function getCapabilityLinkTargetRule(
  config: LinkTargetConfig,
  type: CapabilityType
): CapabilityLinkTargetRule {
  const rule = config.capabilities[type];
  if (!rule) {
    throw new Error(
      `Unsupported bundle item type for ${config.displayName ?? "target"} link: ${type}`
    );
  }
  return rule;
}

function assertSafeLinkTargetConfig(tool: string, config: LinkTargetConfig): void {
  for (const rule of Object.values(config.capabilities)) {
    if (!rule) continue;
    const path = rule.mode === "directory-symlink" ? rule.root : rule.output;
    assertSafeLinkTargetPath(tool, path);
  }

  if (config.instructions) assertSafeLinkTargetPath(tool, config.instructions.output);

  if (config.hooks) {
    const path =
      config.hooks.mode === "claude-settings-hooks" ? config.hooks.settings : config.hooks.root;
    assertSafeLinkTargetPath(tool, path);
  }
}

function assertSafeLinkTargetPath(tool: string, path: string): void {
  if (!path) return;
  const normalized = path.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Unsafe link target path for ${tool}: ${path}`);
  }
}
