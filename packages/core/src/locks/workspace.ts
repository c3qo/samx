import type { SamxLock } from "@c3qo/samx-schemas";
import { samxLockSchema } from "@c3qo/samx-schemas";

import { atomicWriteJson, readJsonFile } from "../store/atomic.js";
import { samxPaths, validateStoreId } from "../store/paths.js";

const emptySamxLock: SamxLock = {
  schemaVersion: 1,
  trustedRegistries: [],
  registries: {},
  formulas: [],
};

type SamxLockFormula = SamxLock["formulas"][number];

export interface SamxLockOptions {
  samxHome?: string;
}

export interface AddTrustedRegistryOptions extends SamxLockOptions {
  registry: string;
}

export interface UpsertFormulaInSamxLockOptions extends SamxLockOptions {
  registry: {
    id: string;
    url: string;
    commit: string;
  };
  formula: SamxLockFormula;
}

export interface RemoveFormulaFromSamxLockOptions extends SamxLockOptions {
  id: string;
}

export interface RemoveRegistryFromSamxLockOptions extends SamxLockOptions {
  registry: string;
}

export async function readSamxLock(options: SamxLockOptions = {}): Promise<SamxLock> {
  return samxLockSchema.parse(
    await readJsonFile(samxPaths(options.samxHome).samxLock, emptySamxLock)
  );
}

export async function writeSamxLock(options: SamxLockOptions, lock: SamxLock): Promise<SamxLock> {
  const parsed = samxLockSchema.parse(lock);
  await atomicWriteJson(samxPaths(options.samxHome).samxLock, parsed);
  return parsed;
}

export async function addTrustedRegistry(options: AddTrustedRegistryOptions): Promise<SamxLock> {
  const { registry } = options;
  validateStoreId(registry);
  const lock = await readSamxLock(options);
  if (!lock.trustedRegistries.includes(registry)) {
    lock.trustedRegistries.push(registry);
  }
  lock.trustedRegistries = [...new Set(lock.trustedRegistries)].sort();
  return writeSamxLock(options, lock);
}

export async function upsertFormulaInSamxLock(
  options: UpsertFormulaInSamxLockOptions
): Promise<SamxLock> {
  const { registry, formula } = options;
  validateStoreId(registry.id);
  if (formula.id === "") {
    throw new Error("Formula id is required");
  }
  const lock = await readSamxLock(options);
  const nextFormula = formula;
  lock.registries[registry.id] = { url: registry.url, commit: registry.commit };
  const existingIndex = lock.formulas.findIndex((entry) => entry.id === formula.id);
  if (existingIndex === -1) {
    lock.formulas.push(nextFormula);
  } else {
    lock.formulas[existingIndex] = nextFormula;
  }
  lock.formulas.sort((a, b) => a.id.localeCompare(b.id));
  return writeSamxLock(options, lock);
}

export async function removeFormulaFromSamxLock(
  options: RemoveFormulaFromSamxLockOptions
): Promise<SamxLock> {
  if (options.id === "") {
    throw new Error("Formula id is required");
  }
  const lock = await readSamxLock(options);
  lock.formulas = lock.formulas.filter((entry) => entry.id !== options.id);
  return writeSamxLock(options, lock);
}

export async function removeRegistryFromSamxLock(
  options: RemoveRegistryFromSamxLockOptions
): Promise<SamxLock> {
  validateStoreId(options.registry);
  const lock = await readSamxLock(options);
  lock.trustedRegistries = lock.trustedRegistries.filter(
    (registry) => registry !== options.registry
  );
  delete lock.registries[options.registry];
  return writeSamxLock(options, lock);
}
