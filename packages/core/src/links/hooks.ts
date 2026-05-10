import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { LinkPlanHook } from "../linkers/types.js";
import { atomicWriteJson, readJsonFile } from "../store/atomic.js";

export interface HookIdentityInput {
  packageId: string;
  hookId: string;
  bundleId: string;
  tool: "claude" | "opencode";
}

function hookSentinel(input: HookIdentityInput): string {
  return `${input.packageId}:${input.hookId}:${input.bundleId}:${input.tool}`;
}

export function hookExtensionAllowed(path: string, allowedExtensions: readonly string[]): boolean {
  const extension = extname(path).toLowerCase();
  return allowedExtensions.map((value) => value.toLowerCase()).includes(extension);
}

export function fingerprintJson(value: unknown): string {
  return sha256(JSON.stringify(normalizeForFingerprint(value)));
}

export async function fingerprintFile(path: string): Promise<string> {
  try {
    const content = await readFile(path);
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
  } catch {
    throw new Error(`Hook source file unreadable: ${path}`);
  }
}

export function annotateClaudeHooks(value: unknown, identity: HookIdentityInput): unknown {
  if (!isRecord(value) || !isRecord(value.hooks)) {
    throw new Error("Invalid Claude hooks: expected { hooks: { event: group[] } }");
  }

  const annotatedHooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(value.hooks)) {
    if (!Array.isArray(groups)) {
      throw new Error(`Invalid Claude hooks: event ${event} must be a group[]`);
    }
    const matchers = new Set<string>();
    annotatedHooks[event] = groups.map((group, index) => {
      if (!isRecord(group)) {
        throw new Error(`Invalid Claude hooks: event ${event} group ${index} must be an object`);
      }
      if (!Array.isArray(group.hooks)) {
        throw new Error(`Invalid Claude hooks: event ${event} group ${index} must contain hooks[]`);
      }
      if (typeof group.matcher === "string") {
        if (matchers.has(group.matcher)) {
          throw new Error(
            `Invalid Claude hooks: event ${event} has duplicate matcher: ${group.matcher}`
          );
        }
        matchers.add(group.matcher);
      }
      return {
        ...group,
        _samx: hookSentinel(identity),
        _samxFingerprint: fingerprintJson(group),
      };
    });
  }

  return { ...value, hooks: annotatedHooks };
}

export async function mergeClaudeHookSettings(
  settingsPath: string,
  hookPreview: unknown
): Promise<void> {
  const preview = claudeHookRoot(hookPreview);
  const settings = await readJsonFile<Record<string, unknown>>(settingsPath, {});
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};

  assertClaudeHookMergeable(hooks, preview);

  for (const [event, groups] of Object.entries(preview.hooks)) {
    const existingGroups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const newGroups = groups.map((group) => ({ ...group }));
    const newSentinels = new Set(newGroups.map((group) => group._samx));
    const retainedGroups = existingGroups.filter(
      (group) =>
        !isRecord(group) || typeof group._samx !== "string" || !newSentinels.has(group._samx)
    );

    hooks[event] = [...retainedGroups, ...newGroups];
  }

  settings.hooks = hooks;
  await atomicWriteJson(settingsPath, settings);
}

export async function assertClaudeHookSettingsMergeable(
  settingsPath: string,
  hookPreview: unknown
): Promise<void> {
  const preview = claudeHookRoot(hookPreview);
  const settings = await readJsonFile<Record<string, unknown>>(settingsPath, {});
  assertClaudeHookMergeable(isRecord(settings.hooks) ? settings.hooks : {}, preview);
}

export async function claudeHookDrift(
  settingsPath: string,
  hookPreview: unknown
): Promise<Array<{ sentinel: string; expected: string; actual: string }>> {
  const preview = claudeHookRoot(hookPreview);
  const settings = await readJsonFile<Record<string, unknown>>(settingsPath, {});
  const settingsHooks = isRecord(settings.hooks) ? settings.hooks : {};
  const drift: Array<{ sentinel: string; expected: string; actual: string }> = [];

  for (const [event, groups] of Object.entries(preview.hooks)) {
    const existingGroups = Array.isArray(settingsHooks[event]) ? settingsHooks[event] : [];
    for (const group of groups) {
      for (const existingGroup of existingGroups) {
        if (
          !isRecord(existingGroup) ||
          existingGroup._samx !== group._samx ||
          typeof existingGroup._samxFingerprint !== "string"
        ) {
          continue;
        }
        const actual = fingerprintJson(existingGroup);
        if (existingGroup._samxFingerprint !== actual) {
          drift.push({ sentinel: group._samx, expected: existingGroup._samxFingerprint, actual });
        }
      }
    }
  }

  return drift;
}

export async function removeClaudeHookSentinels(
  settingsPath: string,
  sentinels: string[]
): Promise<void> {
  if (sentinels.length === 0) return;
  const settings = await readJsonFile<Record<string, unknown>>(settingsPath, {});
  if (!isRecord(settings.hooks)) return;

  const sentinelSet = new Set(sentinels);
  let changed = false;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    const retained = groups.filter(
      (group) => !isRecord(group) || !sentinelSet.has(String(group._samx))
    );
    if (retained.length !== groups.length) {
      settings.hooks[event] = retained;
      changed = true;
    }
  }

  if (changed) {
    await atomicWriteJson(settingsPath, settings);
  }
}

export function hookSentinels(hook: LinkPlanHook): string[] {
  if (hook.kind !== "jsonMerge") return [];
  const preview = claudeHookRoot(hook.preview);
  return unique(
    Object.values(preview.hooks).flatMap((groups) => groups.map((group) => group._samx))
  );
}

export function hookFingerprints(hook: LinkPlanHook): string[] {
  if (hook.kind !== "jsonMerge") return [hook.fingerprint];
  const preview = claudeHookRoot(hook.preview);
  return unique(
    Object.values(preview.hooks).flatMap((groups) => groups.map((group) => group._samxFingerprint))
  );
}

function claudeHookRoot(value: unknown): {
  hooks: Record<
    string,
    Array<Record<string, unknown> & { _samx: string; _samxFingerprint: string }>
  >;
} {
  if (!isRecord(value) || !isRecord(value.hooks)) {
    throw new Error("Invalid Claude hooks: expected { hooks: { event: group[] } }");
  }
  const hooks: Record<
    string,
    Array<Record<string, unknown> & { _samx: string; _samxFingerprint: string }>
  > = {};
  for (const [event, groups] of Object.entries(value.hooks)) {
    if (!Array.isArray(groups)) {
      throw new Error(`Invalid Claude hooks: event ${event} must be a group[]`);
    }
    hooks[event] = groups.map((group, index) => {
      if (!isRecord(group)) {
        throw new Error(`Invalid Claude hooks: event ${event} group ${index} must be an object`);
      }
      if (typeof group._samx !== "string" || typeof group._samxFingerprint !== "string") {
        throw new Error(
          `Invalid Claude hooks: event ${event} group ${index} missing SAMX metadata`
        );
      }
      return group as Record<string, unknown> & { _samx: string; _samxFingerprint: string };
    });
  }
  return { hooks };
}

function assertClaudeHookMergeable(
  settingsHooks: Record<string, unknown>,
  preview: { hooks: Record<string, Array<Record<string, unknown> & { _samx: string }>> }
): void {
  for (const [event, groups] of Object.entries(preview.hooks)) {
    const existingGroups = Array.isArray(settingsHooks[event]) ? settingsHooks[event] : [];
    const newSentinels = new Set(groups.map((group) => group._samx));
    const retainedGroups = existingGroups.filter(
      (group): group is Record<string, unknown> =>
        isRecord(group) && (typeof group._samx !== "string" || !newSentinels.has(group._samx))
    );
    for (const newGroup of groups) {
      for (const existingGroup of retainedGroups) {
        if (existingGroup._samx === undefined && existingGroup.matcher === newGroup.matcher) {
          throw new Error(
            `Claude hook already exists for event ${event} and matcher ${String(newGroup.matcher)}`
          );
        }
      }
    }
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForFingerprint(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "_samx" || key === "_samxFingerprint") {
      continue;
    }
    normalized[key] = normalizeForFingerprint(value[key]);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
