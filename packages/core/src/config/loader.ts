import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginManifestSchema, pluginRulesSchema } from "@c3qo/samx-schemas";
import { parse as parseYaml } from "yaml";

import { createConfigRegistry } from "./registry.js";
import type { ConfigRegistry, LoadedPluginPack } from "./types.js";

let builtinRegistryPromise: Promise<ConfigRegistry> | undefined;
let builtinRegistry: ConfigRegistry | undefined;

export async function loadBuiltinConfigRegistry(): Promise<ConfigRegistry> {
  builtinRegistryPromise ??= Promise.resolve(loadBuiltinConfigRegistrySync());
  return builtinRegistryPromise;
}

export function loadBuiltinConfigRegistrySync(): ConfigRegistry {
  builtinRegistry ??= loadConfigRegistryFromDirectorySync(builtinPacksDirectorySync());
  return builtinRegistry;
}

function loadConfigRegistryFromDirectorySync(packsDirectory: string): ConfigRegistry {
  const packIds = readdirSync(packsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return createConfigRegistry(packIds.map((packId) => loadPackSync(join(packsDirectory, packId))));
}

function loadPackSync(packDirectory: string): LoadedPluginPack {
  const manifestYaml = readFileSync(join(packDirectory, "samx.plugin.yaml"), "utf8");
  const rulesYaml = readFileSync(join(packDirectory, "rules.yaml"), "utf8");
  const manifest = pluginManifestSchema.parse(parseYaml(manifestYaml));
  const rules = pluginRulesSchema.parse(parseYaml(rulesYaml) ?? {});
  validateRegexRules(
    manifest.id,
    rules.inference.filesystem.map((rule) => rule.pattern)
  );
  validateRegexRules(
    manifest.id,
    rules.inference.shellRisks.map((rule) => rule.pattern)
  );
  return { ...manifest, rules };
}

function validateRegexRules(packId: string, patterns: string[]): void {
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, "u");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid regex in plugin pack ${packId}: ${pattern}: ${message}`);
    }
  }
}

function builtinPacksDirectorySync(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "config/packs"),
    resolve(here, "../../config/packs"),
    resolve(here, "../../../config/packs"),
  ];

  for (const candidate of candidates) {
    try {
      readdirSync(candidate);
      return candidate;
    } catch {
      // Try the next source/dist layout candidate.
    }
  }

  return candidates[0];
}
