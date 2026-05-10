import type {
  ClassifyRule,
  GroupRule,
  InferenceRules,
  LinkTargetConfig,
  ParseRules,
  PluginConfig,
  PluginManifest,
  ProbeRules,
} from "@c3qo/samx-schemas";

export type LoadedPluginPack = PluginConfig;

export interface ConfigRegistry {
  packs: PluginManifest[];
  scan: {
    project: string[];
    home: string[];
    ignoredDirectories: string[];
  };
  classify: ClassifyRule[];
  groups: GroupRule[];
  parse: ParseRules;
  inference: InferenceRules;
  probes: ProbeRules;
  linkTargets: Record<string, LinkTargetConfig>;
}
