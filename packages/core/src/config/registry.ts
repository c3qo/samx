import type { ConfigRegistry, LoadedPluginPack } from "./types.js";

export function createConfigRegistry(packs: LoadedPluginPack[]): ConfigRegistry {
  const sortedPacks = [...packs].sort((a, b) => a.id.localeCompare(b.id));

  return {
    packs: sortedPacks.map(({ rules: _rules, ...manifest }) => manifest),
    scan: {
      project: unique(sortedPacks.flatMap((pack) => pack.rules.scan.project)),
      home: unique(sortedPacks.flatMap((pack) => pack.rules.scan.home)),
      ignoredDirectories: unique(sortedPacks.flatMap((pack) => pack.rules.scan.ignoredDirectories)),
    },
    classify: sortedPacks.flatMap((pack) => pack.rules.classify),
    groups: sortedPacks.flatMap((pack) => pack.rules.groups ?? []),
    parse: {
      markdownFrontmatterKinds: unique(
        sortedPacks.flatMap((pack) => pack.rules.parse.markdownFrontmatterKinds)
      ),
      mcpJsonKinds: unique(sortedPacks.flatMap((pack) => pack.rules.parse.mcpJsonKinds)),
      profileKinds: unique(sortedPacks.flatMap((pack) => pack.rules.parse.profileKinds)),
      packageJsonKinds: unique(sortedPacks.flatMap((pack) => pack.rules.parse.packageJsonKinds)),
    },
    inference: {
      commands: unique(sortedPacks.flatMap((pack) => pack.rules.inference.commands)),
      env: unique(sortedPacks.flatMap((pack) => pack.rules.inference.env)),
      filesystem: sortedPacks.flatMap((pack) => pack.rules.inference.filesystem),
      shellRisks: sortedPacks.flatMap((pack) => pack.rules.inference.shellRisks),
      broadMcpFilesystemRoots: unique(
        sortedPacks.flatMap((pack) => pack.rules.inference.broadMcpFilesystemRoots)
      ),
      networkCommands: unique(sortedPacks.flatMap((pack) => pack.rules.inference.networkCommands)),
    },
    probes: {
      safeCommands: unique(sortedPacks.flatMap((pack) => pack.rules.probes.safeCommands)),
    },
    linkTargets: mergeLinkTargets(sortedPacks),
  };
}

function mergeLinkTargets(packs: LoadedPluginPack[]): ConfigRegistry["linkTargets"] {
  const targets: ConfigRegistry["linkTargets"] = {};
  for (const pack of packs) {
    for (const [id, target] of Object.entries(pack.rules.linkTargets ?? {})) {
      if (targets[id]) {
        throw new Error(`Duplicate link target in plugin packs: ${id}`);
      }
      targets[id] = target;
    }
  }
  return targets;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
