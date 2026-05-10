import { describe, expect, test } from "vitest";
import {
  bundleSchema,
  linkRecordSchema,
  linkTargetSchema,
  packageManifestSchema,
  skillIndexSchema,
} from "@c3qo/samx-schemas";

describe("Slice 1 schemas", () => {
  test("accepts data-driven link target ids", () => {
    expect(linkTargetSchema.parse("generic-markdown")).toBe("generic-markdown");
    expect(linkTargetSchema.parse("opencode")).toBe("opencode");
    expect(linkTargetSchema.parse("claude")).toBe("claude");
    expect(linkTargetSchema.parse("codex")).toBe("codex");
    expect(linkTargetSchema.parse("kiro")).toBe("kiro");
    expect(linkTargetSchema.parse("cursor")).toBe("cursor");
    expect(() => linkTargetSchema.parse("")).toThrow();
  });

  test("validates package manifests and skill indexes", () => {
    expect(
      packageManifestSchema.parse({
        packages: [
          {
            id: "superpowers",
            source: "/tmp/superpowers",
            type: "local",
            path: "/tmp/superpowers",
            lastSyncedAt: "2026-05-13T00:00:00.000Z",
          },
        ],
      }).packages[0]?.id
    ).toBe("superpowers");

    expect(
      skillIndexSchema.parse({
        skills: [
          {
            id: "superpowers:code-review",
            packageId: "superpowers",
            name: "code-review",
            kind: "skill",
            path: "/tmp/superpowers/code-review/SKILL.md",
            description: "Review code.",
          },
        ],
      }).skills[0]?.id
    ).toBe("superpowers:code-review");
  });

  test("validates global bundles and link records", () => {
    expect(
      bundleSchema.parse({
        id: "coding",
        items: [{ id: "superpowers:code-review", kind: "skill" }],
      }).id
    ).toBe("coding");
    expect(
      linkRecordSchema.parse({
        id: "coding:generic-markdown:/workspace/project",
        bundleId: "coding",
        tool: "generic-markdown",
        projectRoot: "/workspace/project",
        generatedFiles: ["/workspace/project/SAMX_SKILLS.md"],
        createdAt: "2026-05-13T00:00:00.000Z",
      }).tool
    ).toBe("generic-markdown");
  });
});
