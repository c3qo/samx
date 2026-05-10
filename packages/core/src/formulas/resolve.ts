import { createHash } from "node:crypto";
import type { RecipeLock } from "@c3qo/samx-schemas";
import { recipeLockSchema } from "@c3qo/samx-schemas";

import { readSamxLock } from "../locks/workspace.js";
import { resolveRemoteSourceHead, resolveRemoteSourceRef } from "../registries/git.js";
import { getRegistry } from "../registries/store.js";
import { readFormulaFile, splitFormulaId } from "./read.js";

export interface ResolveFormulaOptions {
  samxHome?: string;
  id: string;
  registryCommit: string;
  sourceRevision?: string;
  sourceHead?: boolean;
  sourceRef?: string;
}

export async function resolveFormula(options: ResolveFormulaOptions): Promise<RecipeLock> {
  const { registry, formula } = splitFormulaId(options.id);
  const [formulaFile, registryRecord, lock] = await Promise.all([
    readFormulaFile(options),
    getRegistry({ samxHome: options.samxHome, id: registry }),
    readSamxLock(options),
  ]);
  const formulaValue = formulaFile.formula;
  let source = formulaValue.source;
  if (formulaValue.source.type === "git") {
    const trustedRegistry = lock.trustedRegistries.includes(registry);
    const localRegistry = new URL(registryRecord.url).protocol === "file:";
    if (
      new URL(formulaValue.source.url).protocol === "file:" &&
      !trustedRegistry &&
      !localRegistry
    ) {
      throw new Error("file:// source URLs require a local trusted registry");
    }
    const sourceRevision = options.sourceHead
      ? options.sourceRef
        ? await resolveRemoteSourceRef(formulaValue.source.url, options.sourceRef)
        : await resolveRemoteSourceHead(formulaValue.source.url)
      : (options.sourceRevision ?? formulaValue.source.revision);
    source = { ...formulaValue.source, revision: sourceRevision };
  }
  return recipeLockSchema.parse({
    schemaVersion: 1,
    id: options.id,
    formula: {
      registry,
      path: formulaFile.path,
      registryUrl: registryRecord.url,
      registryCommit: options.registryCommit,
      formulaHash: `sha256:${createHash("sha256").update(formulaFile.raw).digest("hex")}`,
    },
    source,
    capabilities: formulaValue.capabilities.map((capability) => ({
      ...capability,
      id: `${registry}/${formula}:${capability.id}`,
      formulaCapabilityId: capability.id,
    })),
    requirements: formulaValue.requirements,
    hooks: formulaValue.hooks,
    advisories: formulaValue.advisories,
  });
}
