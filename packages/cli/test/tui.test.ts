import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, test } from "vitest";

import { atomicWriteJson, createBundle, samxPaths } from "@c3qo/samx-core";

import { App } from "../src/tui/App.js";
import type { TuiApi } from "../src/tui/api.js";
import { createTuiApi } from "../src/tui/api.js";
import {
  redactedJson,
  renderPreviewJson,
  safeBlock,
  shouldRedactKey,
  truncateMiddle,
} from "../src/tui/format.js";

const execFileAsync = promisify(execFile);

describe("TUI facade", () => {
  test("loads link targets from registry through facade", async () => {
    const api = createTuiApi({ projectRoot: process.cwd() });

    await expect(api.listLinkTargets()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "claude", label: "Claude" }),
        expect.objectContaining({ id: "opencode", label: "OpenCode" }),
        expect.objectContaining({ id: "kiro", label: "Kiro" }),
      ])
    );
  });

  test("previews before apply and keeps preview read-only", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-link-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-tui-link-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-tui-link-source-"));
    await mkdir(join(source, "skills", "review"), { recursive: true });
    await writeFile(join(source, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await atomicWriteJson(samxPaths(samxHome).index, {
      capabilities: [
        {
          id: "pkg:skills-review",
          packageId: "pkg",
          name: "review",
          kind: "skill",
          path: join(source, "skills", "review", "SKILL.md"),
          metadata: { body: "# Review\n" },
        },
      ],
    });
    await createBundle({ samxHome, id: "coding" });
    const api = createTuiApi({ samxHome, projectRoot });
    await api.addCapabilityToBundle("coding", "pkg:skills-review");

    const preview = await api.previewLink({ bundleId: "coding", tool: "opencode" });
    const destination = join(projectRoot, ".opencode", "skills", "pkg-skills-review");

    expect(preview.generatedFiles).toEqual([destination]);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });

    await api.applyLink({ bundleId: "coding", tool: "opencode" });
    await expect(readFile(join(destination, "SKILL.md"), "utf8")).resolves.toContain("# Review");
  });

  test("returns managed hooks for hook link previews", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-hook-home-"));
    const projectRoot = await mkdtemp(join(tmpdir(), "samx-tui-hook-project-"));
    const source = await mkdtemp(join(tmpdir(), "samx-tui-hook-source-"));
    const skillPath = join(source, "skills", "review", "SKILL.md");
    const hookPath = join(source, "hooks", "safe-bash.js");
    await mkdir(join(source, "skills", "review"), { recursive: true });
    await mkdir(join(source, "hooks"), { recursive: true });
    await writeFile(skillPath, "# Review\n", "utf8");
    await writeFile(hookPath, "export default {}\n", "utf8");
    await atomicWriteJson(samxPaths(samxHome).index, {
      capabilities: [
        {
          id: "pkg:skills-review",
          packageId: "pkg",
          name: "review",
          kind: "skill",
          path: skillPath,
          metadata: { body: "# Review\n" },
          hooks: [
            {
              id: "safe-bash",
              packageId: "pkg",
              tool: "opencode",
              file: hookPath,
              required: true,
              appliesTo: ["skill:review"],
            },
          ],
        },
      ],
    });
    await createBundle({ samxHome, id: "coding" });
    const api = createTuiApi({ samxHome, projectRoot });
    await api.addCapabilityToBundle("coding", "pkg:skills-review");

    const preview = await api.previewLink({ bundleId: "coding", tool: "opencode" });

    expect(preview.managedHooks).toEqual([
      {
        id: "safe-bash",
        tool: "opencode",
        required: true,
        appliesTo: ["skill:review"],
        output: join(projectRoot, ".opencode", "plugins", "pkg-safe-bash.js"),
        risk: "executable behavior",
        drift: false,
      },
    ]);
  });

  test("adds and removes bundle capabilities through facade", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-bundle-update-home-"));
    const source = await mkdtemp(join(tmpdir(), "samx-tui-bundle-update-source-"));
    await mkdir(join(source, "skills", "review"), { recursive: true });
    await writeFile(join(source, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    await atomicWriteJson(samxPaths(samxHome).index, {
      capabilities: [
        {
          id: "pkg:skills-review",
          packageId: "pkg",
          name: "review",
          kind: "skill",
          path: join(source, "skills", "review", "SKILL.md"),
          metadata: { body: "# Review\n" },
        },
      ],
    });
    await createBundle({ samxHome, id: "coding" });
    const api = createTuiApi({ samxHome, projectRoot: source });

    await api.addCapabilityToBundle("coding", "pkg:skills-review");
    await expect(api.getBundle("coding")).resolves.toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ id: "pkg:skills-review", kind: "skill" })],
      })
    );

    await api.removeCapabilityFromBundle("coding", "pkg:skills-review");
    await expect(api.getBundle("coding")).resolves.toEqual(expect.objectContaining({ items: [] }));
  });

  test("destroys bundles through facade", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-bundle-destroy-home-"));
    const api = createTuiApi({ samxHome, projectRoot: samxHome });
    await api.createBundle("coding");

    await api.destroyBundle("coding");

    await expect(api.listBundles()).resolves.toEqual([]);
  });

  test("installs, lists, and uninstalls local packages through facade", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-local-home-"));
    const source = await mkdtemp(join(tmpdir(), "samx-tui-local-source-"));
    await mkdir(join(source, "skills", "review"), { recursive: true });
    await writeFile(join(source, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
    const api = createTuiApi({ samxHome, projectRoot: source });
    const resolvedSource = await realpath(source);

    await expect(api.installLocalPackage("localpkg", source)).resolves.toBe("localpkg");
    await expect(api.listPackages()).resolves.toEqual([
      expect.objectContaining({ id: "localpkg", source: resolvedSource, type: "local" }),
    ]);

    await api.uninstallPackage("localpkg");
    await expect(api.listPackages()).resolves.toEqual([]);
  });

  test("searches and reads registry formulas through facade", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-registry-home-"));
    const registry = samxPaths(samxHome).registryRoot("local");
    await mkdir(join(registry, "formulas", "acme"), { recursive: true });
    await writeFile(
      join(registry, "formulas", "acme", "review.yaml"),
      [
        "schemaVersion: 1",
        "id: acme/review",
        "name: Review Pack",
        "description: Code review helper",
        "source:",
        "  type: virtual",
        "capabilities:",
        "  - id: github",
        "    kind: mcp",
        "    description: GitHub MCP",
        "    spec:",
        "      serverName: github",
        "      transport: remote",
        "      sourceFormat: direct",
        "      config:",
        "        url: https://example.com/mcp",
        "",
      ].join("\n"),
      "utf8"
    );
    const api = createTuiApi({ samxHome, projectRoot: registry });
    await api.addRegistry("local", registry, false);

    await expect(api.listRegistries()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "local", url: registry, trusted: false }),
      ])
    );
    await expect(api.searchFormulas("review")).resolves.toEqual([
      expect.objectContaining({
        id: "local/acme/review",
        name: "Review Pack",
        description: "Code review helper",
      }),
    ]);
    await expect(api.getFormula("local/acme/review")).resolves.toEqual({
      id: "local/acme/review",
      canonicalId: "local/acme/review",
      name: "Review Pack",
      description: "Code review helper",
      capabilities: [{ id: "github", kind: "mcp" }],
    });
  });

  test("returns visible ids when reading default registry formulas through facade", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-default-formula-home-"));
    await writeVirtualFormula(samxPaths(samxHome).registryRoot("default"), "acme/review");
    const api = createTuiApi({ samxHome, projectRoot: samxHome });

    await expect(api.getFormula("default/acme/review")).resolves.toEqual(
      expect.objectContaining({ id: "acme/review" })
    );
  });

  test("installs, previews updates, applies updates, and uninstalls formula packages through facade", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-formula-home-"));
    const registrySource = await mkdtemp(join(tmpdir(), "samx-tui-formula-registry-"));
    await writeVirtualFormula(registrySource, "acme/review", "github");
    await writeVirtualFormula(registrySource, "acme/unchanged", "stable");
    await initGitRepo(registrySource);
    const api = createTuiApi({ samxHome, projectRoot: registrySource });

    await api.addRegistry("local", pathToFileURL(registrySource).href);
    await expect(api.installFormulaPackage("local/acme/review")).resolves.toBe("local/acme/review");
    await expect(api.installFormulaPackage("local/acme/unchanged")).resolves.toBe(
      "local/acme/unchanged"
    );
    await expect(api.listPackages()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "local/acme/review", type: "virtual" }),
        expect.objectContaining({ id: "local/acme/unchanged", type: "virtual" }),
      ])
    );

    await writeVirtualFormula(registrySource, "acme/review", "github2");
    await git(registrySource, "add", ".");
    await git(registrySource, "commit", "-m", "update formula");
    await expect(api.syncRegistry("local")).resolves.toBe(1);
    await expect(api.previewPackageUpdates("local/acme/review")).resolves.toEqual([
      expect.objectContaining({
        id: "local/acme/review",
        changes: expect.arrayContaining([
          expect.objectContaining({
            field: "capabilities.added",
            values: ["local/acme/review:github2"],
          }),
        ]),
      }),
    ]);
    await expect(api.applyPackageUpdates()).resolves.toBe(1);
    await expect(api.previewPackageUpdates("local/acme/review")).resolves.toEqual([]);

    await writeVirtualFormula(registrySource, "acme/review", "github3");
    await git(registrySource, "add", ".");
    await git(registrySource, "commit", "-m", "update formula again");
    await expect(api.syncRegistry("local")).resolves.toBe(1);
    await expect(api.applyPackageUpdates("local/acme/review")).resolves.toBe(1);
    await expect(api.previewPackageUpdates("local/acme/review")).resolves.toEqual([]);

    await api.uninstallPackage("local/acme/review");
    await api.uninstallPackage("local/acme/unchanged");
    await expect(api.listPackages()).resolves.toEqual([]);
  });

  test("package update preview reports per-package registry errors without aborting", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-formula-missing-registry-home-"));
    const registrySource = await mkdtemp(join(tmpdir(), "samx-tui-formula-missing-registry-"));
    await writeVirtualFormula(registrySource, "acme/review", "github");
    await initGitRepo(registrySource);
    const api = createTuiApi({ samxHome, projectRoot: registrySource });

    await api.addRegistry("local", pathToFileURL(registrySource).href);
    await api.installFormulaPackage("local/acme/review");
    await rm(samxPaths(samxHome).registryRoot("local"), { recursive: true, force: true });

    await expect(api.previewPackageUpdates()).resolves.toEqual([
      expect.objectContaining({
        id: "local/acme/review",
        error: expect.stringContaining("no such file or directory"),
      }),
    ]);
  });

  test("syncs, trusts, and removes registries through facade", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-registry-ops-home-"));
    const registrySource = await mkdtemp(join(tmpdir(), "samx-tui-registry-ops-source-"));
    await writeVirtualFormula(registrySource, "acme/review");
    await initGitRepo(registrySource);
    const api = createTuiApi({ samxHome, projectRoot: registrySource });

    await api.addRegistry("local", registrySource);
    await expect(api.syncRegistry("local")).resolves.toBe(1);
    await api.trustRegistry("local");
    await expect(api.listRegistries()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "local", trusted: true })])
    );
    await expect(api.removeRegistry("local")).resolves.toEqual({
      installedPackagesRemaining: false,
    });
    await expect(api.listRegistries()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "local" })])
    );
  });

  test("rejects invalid registry adds before cloning", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-invalid-registry-home-"));
    const registrySource = await mkdtemp(join(tmpdir(), "samx-tui-invalid-registry-source-"));
    await writeVirtualFormula(registrySource, "acme/review");
    await initGitRepo(registrySource);
    const api = createTuiApi({ samxHome, projectRoot: registrySource });

    await expect(api.addRegistry("default", registrySource)).rejects.toThrow(
      "Cannot replace built-in registry: default"
    );
    await expect(stat(samxPaths(samxHome).registryRoot("default"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not persist registry when clone fails", async () => {
    const samxHome = await mkdtemp(join(tmpdir(), "samx-tui-registry-clone-fail-home-"));
    const missingRegistry = join(
      await mkdtemp(join(tmpdir(), "samx-tui-registry-clone-fail-source-")),
      "missing"
    );
    const api = createTuiApi({ samxHome, projectRoot: samxHome });

    await expect(api.addRegistry("missing", missingRegistry)).rejects.toThrow();
    await expect(api.listRegistries()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "missing" })])
    );
  });
});

describe("TUI formatting safety", () => {
  test("redacts specific MCP secret keys without hiding unrelated key substrings", () => {
    expect(shouldRedactKey("api_key")).toBe(true);
    expect(shouldRedactKey("private_key")).toBe(true);
    expect(shouldRedactKey("key")).toBe(true);
    expect(shouldRedactKey("monkeyMode")).toBe(false);
    expect(shouldRedactKey("tokenizer")).toBe(false);
    expect(shouldRedactKey("authenticationMode")).toBe(false);
    expect(shouldRedactKey("github_token")).toBe(true);
    expect(shouldRedactKey("aws.secret.access_key")).toBe(true);

    expect(
      redactedJson({
        api_key: "secret",
        monkeyMode: "visible",
        tokenizer: "visible",
        authenticationMode: "visible",
      })
    ).toEqual({
      api_key: "[redacted]",
      monkeyMode: "visible",
      tokenizer: "visible",
      authenticationMode: "visible",
    });
  });

  test("truncates long values for narrow layouts", () => {
    expect(
      truncateMiddle("/a/very/long/path/that/should/not/overflow/the/terminal", 24)
    ).toHaveLength(24);
    expect(renderPreviewJson({ value: "x".repeat(2000) }, 120)).toHaveLength(120);
    expect(safeBlock('github\n{\n  "command": "npx"\n}')).toContain('\n  "command"');
  });

  test("keeps Ink components behind the TuiApi facade", async () => {
    const appSource = await readFile(new URL("../src/tui/App.ts", import.meta.url), "utf8");

    expect(appSource).not.toContain("from '@c3qo/samx-core'");
    expect(appSource).not.toContain("value: capability }");
    expect(appSource).not.toContain("value: record }");
    expect(appSource).toContain("Add capability");
    expect(appSource).toContain("Confirm remove");
    expect(appSource).toContain("Back to dashboard");
    expect(appSource).toContain("Link another bundle");
    expect(appSource).toContain("samx pkg install <registry>/<owner>/<repo>");
    expect(appSource).toContain("Search Formulas");
    expect(appSource).toContain("Manage Registries");
    expect(appSource).not.toContain("key: `${hook.id}:summary`");
  });
});

describe("Ink TUI interactions", () => {
  test("text input captures q/t instead of triggering global shortcuts", async () => {
    const app = render(React.createElement(App, { api: fakeTuiApi() }));
    await flush();

    app.stdin.write("4");
    await flush();
    app.stdin.write("/");
    await flush();
    app.stdin.write("qt");
    await flush();

    expect(app.lastFrame()).toContain("Search capabilities:");
    expect(app.lastFrame()).toContain("qt");
    app.unmount();
  });

  test("link flow previews before apply", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls);
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToLinkPreview(app);
    await waitForFrame(app, "Confirm link");
    await flush();

    expect(app.lastFrame()).toContain("Managed hooks");
    expect(app.lastFrame()).toContain("- safe-bash  claude  required");
    expect(app.lastFrame()).toContain("applies to: skill:review");
    expect(app.lastFrame()).toContain("output: .claude/settings.json");
    expect(app.lastFrame()).toContain("risk: executable behavior");

    app.stdin.write("1");
    await waitForFrame(app, "Link another bundle");

    expect(calls).toEqual(
      expect.arrayContaining([
        "check:coding:claude",
        "preview:coding:claude:false:unspecified",
        "apply:coding:claude:false:unspecified:false",
      ])
    );
    expect(calls.indexOf("preview:coding:claude:false:unspecified")).toBeLessThan(
      calls.indexOf("apply:coding:claude:false:unspecified:false")
    );
    expect(app.lastFrame()).toContain("Link another bundle");
    app.unmount();
  });

  test("link flow shows environment reminders before apply", async () => {
    const api = fakeTuiApi([], { environmentReminders: true });
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToLinkPreview(app);
    await waitForFrame(app, "Confirm link");
    await flush();

    expect(app.lastFrame()).toContain("Environment reminders");
    expect(app.lastFrame()).toContain("pkg requires ANTHROPIC_API_KEY");
    app.unmount();
  });

  test("link flow shows Codex instruction and TOML previews before apply", async () => {
    const api = fakeTuiApi([], { codex: true });
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToLinkPreview(app);
    await waitForFrame(app, "Confirm link");
    await flush();

    expect(app.lastFrame()).toContain("Instructions");
    expect(app.lastFrame()).toContain("AGENTS.md");
    expect(app.lastFrame()).toContain("MCP TOML");
    expect(app.lastFrame()).toContain(".codex/config.toml");
    app.unmount();
  });

  test("link flow requires advisory confirmation before apply", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls, { advisories: true });
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToLinkPreview(app);
    await waitForFrame(app, "Formula advisories");
    await flush();

    expect(app.lastFrame()).toContain("optional-opencode-plugin");
    expect(calls).not.toContain("apply:coding:claude:false:unspecified:true");

    app.stdin.write("1");
    await waitForFrame(app, "Confirm link");
    await flush();
    app.stdin.write("1");
    await waitForFrame(app, "Link another bundle");

    expect(calls).toContain("apply:coding:claude:false:unspecified:true");
    app.unmount();
  });

  test("overwrite retry re-previews before overwrite apply", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls);
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToLinkPreview(app);
    await waitForFrame(app, "Confirm link");
    await flush();
    app.stdin.write("2");
    await waitForFrame(app, "Confirm link with overwrite");
    await flush();
    app.stdin.write("1");
    await waitForFrame(app, "Link another bundle");

    expect(calls).toEqual(
      expect.arrayContaining([
        "preview:coding:claude:false:unspecified",
        "preview:coding:claude:true:unspecified",
        "apply:coding:claude:true:unspecified:false",
      ])
    );
    expect(calls.indexOf("preview:coding:claude:true:unspecified")).toBeLessThan(
      calls.indexOf("apply:coding:claude:true:unspecified:false")
    );
    app.unmount();
  });

  test("link flow requires adjacent hook decision and preserves it for overwrite", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls, { adjacentHookCandidates: true });
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToLinkPreview(app);
    await waitForFrame(app, "Adjacent hook candidates");
    await flush();

    expect(app.lastFrame()).toContain("- review-opencode");
    expect(app.lastFrame()).toContain("packageId: pkg");
    expect(app.lastFrame()).toContain("relative file: skills/review/hooks/opencode.js");
    expect(app.lastFrame()).toContain("appliesTo: skill:review");
    expect(app.lastFrame()).toContain("risk: executable behavior");

    app.stdin.write("2");
    await waitForFrame(app, "Confirm link");
    await flush();
    app.stdin.write("2");
    await waitForFrame(app, "Confirm link with overwrite");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Link another bundle");

    expect(calls).toEqual(
      expect.arrayContaining([
        "preview:coding:claude:false:unspecified",
        "preview:coding:claude:false:none",
        "preview:coding:claude:true:none",
        "apply:coding:claude:true:none:false",
      ])
    );
    expect(calls.indexOf("preview:coding:claude:false:none")).toBeLessThan(
      calls.indexOf("preview:coding:claude:true:none")
    );
    expect(calls.indexOf("preview:coding:claude:true:none")).toBeLessThan(
      calls.indexOf("apply:coding:claude:true:none:false")
    );
    app.unmount();
  });

  test("link flow skips adjacent hook prompt when decision is not required", async () => {
    const api = fakeTuiApi([], { adjacentHookCandidatesWithoutDecision: true });
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToLinkPreview(app);
    await waitForFrame(app, "Confirm link");

    expect(app.lastFrame()).not.toContain("Adjacent hook candidates");
    app.unmount();
  });

  test("failed adjacent hook decision preview keeps decision prompt", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls, {
      adjacentHookCandidates: true,
      failAdjacentDecisionPreview: true,
    });
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToLinkPreview(app);
    await waitForFrame(app, "Adjacent hook candidates");
    await flush();
    app.stdin.write("2");
    await waitForFrame(app, "Could not preview adjacent hook decision");

    expect(app.lastFrame()).toContain("Adjacent hook candidates");
    expect(app.lastFrame()).not.toContain("Confirm link");
    expect(calls).toEqual(
      expect.arrayContaining([
        "preview:coding:claude:false:unspecified",
        "preview:coding:claude:false:none",
      ])
    );
    expect(calls).not.toContain("apply:coding:claude:false:none");
    app.unmount();
  });

  test("bundle add capability supports multiple selections", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls, { singleBundleItem: true });
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToBundleDetail(app);
    app.stdin.write("1");
    await waitForFrame(app, "Add capability to coding");
    await flush();

    expect(app.lastFrame()).toContain("[ ] pkg:agent  agent");
    app.stdin.write(" ");
    await flush();
    app.stdin.write("\u001B[B");
    await flush();
    app.stdin.write(" ");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Added 2 capabilities to coding.");

    expect(calls).toEqual(expect.arrayContaining(["add:coding:pkg:agent", "add:coding:pkg:mcp"]));
    app.unmount();
  });

  test("bundle remove capability supports multiple selections with confirmation", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls);
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToBundleDetail(app);
    app.stdin.write("2");
    await waitForFrame(app, "Remove capability from coding");
    await flush();

    expect(app.lastFrame()).toContain("[ ] skill: pkg:skill");
    app.stdin.write(" ");
    await flush();
    app.stdin.write("\u001B[B");
    await flush();
    app.stdin.write(" ");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Remove 2 capabilities from coding?");
    app.stdin.write("1");
    await waitForFrame(app, "Removed 2 capabilities from coding.");

    expect(calls).toEqual(
      expect.arrayContaining(["remove:coding:pkg:skill", "remove:coding:pkg:agent"])
    );
    app.unmount();
  });

  test("bundle detail destroys bundle after confirmation", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls);
    const app = render(React.createElement(App, { api }));
    await flush();

    await navigateToBundleDetail(app);
    app.stdin.write("3");
    await waitForFrame(app, "Destroy bundle coding?");

    expect(calls).not.toContain("destroy:coding");
    app.stdin.write("1");
    await waitForFrame(app, "Destroyed bundle coding.");

    expect(calls).toContain("destroy:coding");
    app.unmount();
  });

  test("create bundle prompt can be cancelled", async () => {
    const app = render(React.createElement(App, { api: fakeTuiApi() }));
    await waitForFrame(app, "Actions");

    app.stdin.write("5");
    await waitForFrame(app, "Create bundle");
    app.stdin.write("1");
    await waitForFrame(app, "Bundle id:");
    expect(app.lastFrame()).toContain("Enter empty: back to bundles");
    expect(app.lastFrame()).not.toContain("q: quit");
    app.stdin.write("\u001B");
    await waitForFrame(app, "Create bundle");

    app.stdin.write("1");
    await waitForFrame(app, "Bundle id:");
    app.stdin.write("\r");
    await waitForFrame(app, "Create bundle");
    app.unmount();
  });

  test("dashboard exposes package-management flows", async () => {
    const app = render(React.createElement(App, { api: fakeTuiApi() }));
    await waitForFrame(app, "Actions");

    const frame = app.lastFrame() ?? "";
    const expected = [
      "Search Formulas",
      "Manage Registries",
      "Manage Packages",
      "Browse Capability",
      "Manage Bundles",
      "Link Bundle",
      "Unlink Bundle",
      "Quit",
    ];
    for (const label of expected) expect(frame).toContain(label);
    expect(expected.map((label) => frame.indexOf(label))).toEqual(
      expected.map(() => expect.any(Number))
    );
    for (let index = 1; index < expected.length; index += 1) {
      expect(frame.indexOf(expected[index - 1])).toBeLessThan(frame.indexOf(expected[index]));
    }
    app.unmount();
  });

  test("package screen previews and applies updates after confirmation", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls, { packageUpdates: true });
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("3");
    await waitForFrame(app, "Use `samx pkg install");
    app.stdin.write("2");
    await waitForFrame(app, "Package updates");

    expect(app.lastFrame()).toContain("pkg");
    expect(app.lastFrame()).toContain("capabilities.added");
    expect(calls).toContain("preview-updates:all");

    app.stdin.write("1");
    await waitForFrame(app, "Applied 1 package update.");

    expect(calls).toContain("apply-updates:all");
    app.unmount();
  });

  test("package screen with no updates offers only back", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls);
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("3");
    await waitForFrame(app, "Use `samx pkg install");
    app.stdin.write("2");
    await waitForFrame(app, "No package updates available.");

    expect(app.lastFrame()).not.toContain("Apply updates");
    app.stdin.write("1");
    await waitForFrame(app, "Use `samx pkg install");

    expect(calls).toContain("preview-updates:all");
    expect(calls).not.toContain("apply-updates:all");
    app.unmount();
  });

  test("package screen uninstalls selected package after confirmation", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls);
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("3");
    await waitForFrame(app, "Use `samx pkg install");
    app.stdin.write("1");
    await waitForFrame(app, "Package: pkg");
    app.stdin.write("1");
    await waitForFrame(app, "Uninstall pkg?");
    app.stdin.write("1");
    await waitForFrame(app, "Uninstalled pkg.");

    expect(calls).toContain("uninstall:pkg:false");
    app.unmount();
  });

  test("package screen requires explicit force before force uninstall", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls);
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("3");
    await waitForFrame(app, "Use `samx pkg install");
    app.stdin.write("1");
    await waitForFrame(app, "Package: pkg");
    app.stdin.write("1");
    await waitForFrame(app, "Uninstall pkg?");
    app.stdin.write("2");
    await waitForFrame(app, "Force uninstall pkg?");

    expect(calls).not.toContain("uninstall:pkg:true");
    app.stdin.write("1");
    await waitForFrame(app, "Uninstalled pkg.");

    expect(calls).toContain("uninstall:pkg:true");
    app.unmount();
  });

  test("package screen installs formula and local packages from prompts", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls);
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("3");
    await waitForFrame(app, "Use `samx pkg install");
    app.stdin.write("3");
    await waitForFrame(app, "Formula id:");
    app.stdin.write("default/acme/review");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Installed acme/review.");

    app.stdin.write("4");
    await waitForFrame(app, "Local package id:");
    app.stdin.write("localpkg");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Local source path:");
    app.stdin.write("/tmp/localpkg");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Installed local package localpkg.");

    expect(calls).toEqual(
      expect.arrayContaining([
        "install-formula:default/acme/review",
        "install-local:localpkg:/tmp/localpkg",
      ])
    );
    app.unmount();
  });

  test("package install prompts expose back actions", async () => {
    const api = fakeTuiApi();
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("3");
    await waitForFrame(app, "Use `samx pkg install");
    app.stdin.write("3");
    await waitForFrame(app, "Formula id:");
    expect(app.lastFrame()).toContain("Enter empty: back to packages");

    app.stdin.write("\u001B");
    await waitForFrame(app, "Use `samx pkg install");

    app.stdin.write("4");
    await waitForFrame(app, "Local package id:");
    expect(app.lastFrame()).toContain("Enter empty: back to packages");
    app.stdin.write("\r");
    await waitForFrame(app, "Use `samx pkg install");
    app.unmount();
  });

  test("registry screen removes selected registry after confirmation", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls, { extraRegistry: true });
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("2");
    await waitForFrame(app, "Sync all registries");
    expect(app.lastFrame()).toContain("local  trusted  file:///tmp/registry");

    app.stdin.write("1");
    await waitForFrame(app, "Registry: local");
    app.stdin.write("4");
    await waitForFrame(app, "Remove local?");
    app.stdin.write("1");
    await waitForFrame(app, "Removed local.");

    expect(calls).toEqual(expect.arrayContaining(["registry-remove:local:false"]));
    app.unmount();
  });

  test("registry screen adds registry then refreshes list", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls);
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("2");
    await waitForFrame(app, "Sync all registries");
    app.stdin.write("2");
    await waitForFrame(app, "Registry id:");
    app.stdin.write("local");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Registry url:");
    app.stdin.write("file:///tmp/registry");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Added registry local.");

    expect(calls).toEqual(expect.arrayContaining(["registry-add:local:file:///tmp/registry:true"]));
    expect(calls.filter((call) => call === "registry-list").length).toBeGreaterThanOrEqual(2);
    app.unmount();
  });

  test("registry add prompts can be cancelled", async () => {
    const api = fakeTuiApi();
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("2");
    await waitForFrame(app, "Sync all registries");
    app.stdin.write("2");
    await waitForFrame(app, "Registry id:");
    expect(app.lastFrame()).toContain("Enter empty: back to registries");
    app.stdin.write("\u001B");
    await waitForFrame(app, "Sync all registries");

    app.stdin.write("2");
    await waitForFrame(app, "Registry id:");
    app.stdin.write("local");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Registry url:");
    expect(app.lastFrame()).toContain("Enter empty: back to registry id");
    app.stdin.write("\u001B");
    await waitForFrame(app, "Registry id:");
    app.unmount();
  });

  test("registry sync message reports registries", async () => {
    const app = render(React.createElement(App, { api: fakeTuiApi() }));
    await waitForFrame(app, "Actions");

    app.stdin.write("2");
    await waitForFrame(app, "Sync all registries");
    app.stdin.write("3");
    await waitForFrame(app, "Synced all registries: 1 registry.");

    expect(app.lastFrame()).not.toContain("formula");
    app.unmount();
  });

  test("default registry detail hides remove action", async () => {
    const app = render(React.createElement(App, { api: fakeTuiApi() }));
    await waitForFrame(app, "Actions");

    app.stdin.write("2");
    await waitForFrame(app, "Sync all registries");
    app.stdin.write("1");
    await waitForFrame(app, "Registry: default");

    expect(app.lastFrame()).toContain("Sync registry");
    expect(app.lastFrame()).toContain("built-in");
    expect(app.lastFrame()).not.toContain("Remove registry");
    app.unmount();
  });

  test("searches formulas, shows detail, and installs selected formula", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls, { formulaResults: true });
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("1");
    await waitForFrame(app, "Search formulas:");
    app.stdin.write("review");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Review Pack");
    app.stdin.write("1");
    await waitForFrame(app, "Formula: acme/review");

    expect(app.lastFrame()).toContain("Code review helper");
    expect(app.lastFrame()).toContain("github  mcp");

    app.stdin.write("1");
    await waitForFrame(app, "Installed acme/review.");

    expect(calls).toEqual(
      expect.arrayContaining([
        "formula-search:review",
        "formula-get:default/acme/review",
        "install-formula:default/acme/review",
      ])
    );
    app.unmount();
  });

  test("formula search and detail sanitize control text", async () => {
    const api = fakeTuiApi([], { unsafeFormulaResults: true });
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("1");
    await waitForFrame(app, "Search formulas:");
    app.stdin.write("bad\u001B[31mquery");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "BadName");
    expect(app.lastFrame()).not.toContain("\u001B");
    expect(app.lastFrame()).not.toContain("[31m");

    app.stdin.write("1");
    await waitForFrame(app, "Formula: bad/id");
    expect(app.lastFrame()).not.toContain("\u001B");
    expect(app.lastFrame()).not.toContain("[31m");
    expect(app.lastFrame()).toContain("cap  mcp");
    app.unmount();
  });

  test("formula search uses canonical ids when duplicate visible ids exist", async () => {
    const calls: string[] = [];
    const api = fakeTuiApi(calls, { duplicateFormulaResults: true });
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("1");
    await waitForFrame(app, "Search formulas:");
    app.stdin.write("review");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Default Review");
    app.stdin.write("1");
    await waitForFrame(app, "Formula: acme/review");
    app.stdin.write("1");
    await waitForFrame(app, "Installed acme/review.");

    expect(calls).toEqual(
      expect.arrayContaining([
        "formula-get:default/acme/review",
        "install-formula:default/acme/review",
      ])
    );
    app.unmount();
  });

  test("formula search shows loading after submit", async () => {
    const api = fakeTuiApi([], { slowFormulaSearch: true });
    const app = render(React.createElement(App, { api }));
    await waitForFrame(app, "Actions");

    app.stdin.write("1");
    await waitForFrame(app, "Search formulas:");
    app.stdin.write("review");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "Loading...");

    app.unmount();
  });

  test("formula search prompt can return to dashboard", async () => {
    const app = render(React.createElement(App, { api: fakeTuiApi() }));
    await waitForFrame(app, "Actions");

    app.stdin.write("1");
    await waitForFrame(app, "Search formulas:");
    expect(app.lastFrame()).toContain("Enter empty: back to dashboard");
    app.stdin.write("\u001B");
    await waitForFrame(app, "Search Formulas");

    app.stdin.write("1");
    await waitForFrame(app, "Search formulas:");
    app.stdin.write("\r");
    await waitForFrame(app, "Search Formulas");
    app.unmount();
  });

  test("empty formula search results can start a new search", async () => {
    const app = render(React.createElement(App, { api: fakeTuiApi() }));
    await waitForFrame(app, "Actions");

    app.stdin.write("1");
    await waitForFrame(app, "Search formulas:");
    app.stdin.write("missing");
    await flush();
    app.stdin.write("\r");
    await waitForFrame(app, "No formulas found.");
    app.stdin.write("1");
    await waitForFrame(app, "Search formulas:");
    expect(app.lastFrame()).not.toContain("missing");

    app.unmount();
  });
});

function fakeTuiApi(
  calls: string[] = [],
  options: {
    adjacentHookCandidates?: boolean;
    adjacentHookCandidatesWithoutDecision?: boolean;
    failAdjacentDecisionPreview?: boolean;
    advisories?: boolean;
    environmentReminders?: boolean;
    codex?: boolean;
    singleBundleItem?: boolean;
    formulaResults?: boolean;
    unsafeFormulaResults?: boolean;
    duplicateFormulaResults?: boolean;
    extraRegistry?: boolean;
    packageUpdates?: boolean;
    slowFormulaSearch?: boolean;
  } = {}
): TuiApi {
  const registries = [
    ...(options.extraRegistry ? [{ id: "local", url: "file:///tmp/registry", trusted: true }] : []),
    { id: "default", url: "https://github.com/c3qo/samx-registry.git", trusted: false },
  ];
  return {
    async getDashboard() {
      return {
        packages: 1,
        bundles: 1,
        linkedBundles: 0,
        capabilities: { total: 1, skill: 1, agent: 0, mcp: 0 },
      };
    },
    async listPackages() {
      return [{ id: "pkg", source: "/tmp/pkg", type: "local" }];
    },
    async installFormulaPackage(id: string) {
      calls.push(`install-formula:${id}`);
      return id.startsWith("default/") ? id.slice("default/".length) : id;
    },
    async installLocalPackage(id: string, source: string) {
      calls.push(`install-local:${id}:${source}`);
      return id;
    },
    async previewPackageUpdates(id?: string) {
      calls.push(`preview-updates:${id ?? "all"}`);
      return options.packageUpdates
        ? [{ id: "pkg", changes: [{ field: "capabilities.added", values: ["pkg:skill2"] }] }]
        : [];
    },
    async applyPackageUpdates(id?: string) {
      calls.push(`apply-updates:${id ?? "all"}`);
      return options.packageUpdates ? 1 : 0;
    },
    async uninstallPackage(id: string, force?: boolean) {
      calls.push(`uninstall:${id}:${force === true}`);
    },
    async listRegistries() {
      calls.push("registry-list");
      return registries;
    },
    async addRegistry(id: string, url: string, clone?: boolean) {
      calls.push(`registry-add:${id}:${url}:${clone !== false}`);
      registries.unshift({ id, url, trusted: false });
    },
    async syncRegistry(id?: string) {
      calls.push(`registry-sync:${id ?? "all"}`);
      return 1;
    },
    async trustRegistry(id: string) {
      calls.push(`registry-trust:${id}`);
      const registry = registries.find((item) => item.id === id);
      if (registry) registry.trusted = true;
    },
    async removeRegistry(id: string, force?: boolean) {
      calls.push(`registry-remove:${id}:${force === true}`);
      const index = registries.findIndex((item) => item.id === id);
      if (index >= 0) registries.splice(index, 1);
      return { installedPackagesRemaining: false };
    },
    async searchFormulas(query: string) {
      calls.push(`formula-search:${query}`);
      if (options.slowFormulaSearch) await new Promise((resolve) => setTimeout(resolve, 100));
      if (options.duplicateFormulaResults) {
        return [
          {
            id: "acme/review",
            canonicalId: "default/acme/review",
            name: "Default Review",
            description: "Default review helper",
          },
          {
            id: "local/acme/review",
            canonicalId: "local/acme/review",
            name: "Local Review",
            description: "Local review helper",
          },
        ];
      }
      if (options.unsafeFormulaResults)
        return [
          {
            id: "bad\u001B[31m/id",
            canonicalId: "default/bad/id",
            name: "Bad\u001B[31mName",
            description: "Desc\u001B[31m",
          },
        ];
      return options.formulaResults
        ? [
            {
              id: "acme/review",
              canonicalId: "default/acme/review",
              name: "Review Pack",
              description: "Code review helper",
            },
          ]
        : [];
    },
    async getFormula(id: string) {
      calls.push(`formula-get:${id}`);
      if (options.unsafeFormulaResults)
        return {
          id: "bad\u001B[31m/id",
          canonicalId: id,
          name: "Bad\u001B[31mName",
          description: "Desc\u001B[31m",
          capabilities: [{ id: "cap\u001B[31m", kind: "mcp\u001B[31m" as "mcp" }],
        };
      return {
        id: id.startsWith("default/") ? id.slice("default/".length) : id,
        canonicalId: id,
        name: "Review Pack",
        description: "Code review helper",
        capabilities: [{ id: "github", kind: "mcp" }],
      };
    },
    async listCapabilities() {
      return [
        {
          id: "pkg:skill",
          name: "skill",
          kind: "skill",
          packageId: "pkg",
          path: "/tmp/pkg/skills/skill/SKILL.md",
          description: "Skill",
        },
        {
          id: "pkg:agent",
          name: "agent",
          kind: "agent",
          packageId: "pkg",
          path: "/tmp/pkg/agents/agent/AGENT.md",
          description: "Agent",
        },
        {
          id: "pkg:mcp",
          name: "mcp",
          kind: "mcp",
          packageId: "pkg",
          path: "/tmp/pkg/mcp/mcp.json",
          description: "MCP",
        },
      ];
    },
    async listBundles() {
      return [{ id: "coding", itemCount: 1 }];
    },
    async getBundle(id: string) {
      const items = options.singleBundleItem
        ? [{ id: "pkg:skill", kind: "skill" }]
        : [
            { id: "pkg:skill", kind: "skill" },
            { id: "pkg:agent", kind: "agent" },
          ];
      return { id, itemCount: items.length, items };
    },
    async createBundle(id: string) {
      calls.push(`create:${id}`);
    },
    async destroyBundle(id: string) {
      calls.push(`destroy:${id}`);
    },
    async addCapabilityToBundle(bundleId: string, capabilityId: string) {
      calls.push(`add:${bundleId}:${capabilityId}`);
    },
    async removeCapabilityFromBundle(bundleId: string, capabilityId: string) {
      calls.push(`remove:${bundleId}:${capabilityId}`);
    },
    async listLinkTargets() {
      return options.codex
        ? [{ id: "codex", label: "Codex" }]
        : [{ id: "claude", label: "Claude" }];
    },
    async checkBundle(bundleId: string, tool: string) {
      calls.push(`check:${bundleId}:${tool}`);
      return {
        bundleId,
        status: "ready",
        missingItems: [],
        hookBlockers: [],
        hooks: { required: 0, optional: 0 },
        hookCandidates: [],
        enabledAdjacentHooks: [],
        warnings: [],
      };
    },
    async previewLink(input) {
      const adjacentMode = input.adjacentHooks?.mode ?? "unspecified";
      calls.push(
        `preview:${input.bundleId}:${input.tool}:${input.overwrite === true}:${adjacentMode}`
      );
      if (options.failAdjacentDecisionPreview && adjacentMode !== "unspecified") {
        throw new Error("Could not preview adjacent hook decision");
      }
      const hookCandidates =
        (options.adjacentHookCandidates || options.adjacentHookCandidatesWithoutDecision) &&
        adjacentMode === "unspecified"
          ? [
              {
                id: "review-opencode",
                packageId: "pkg",
                relativeFile: "skills/review/hooks/opencode.js",
                appliesTo: ["skill:review"],
              },
            ]
          : [];
      const advisories = options.advisories
        ? [
            {
              packageId: "pkg",
              id: "optional-opencode-plugin",
              severity: "info" as const,
              category: "linking",
              message: "Plugin advisory.",
              paths: [],
              effect: "Only linked when linking.",
              action: "Review before linking.",
            },
          ]
        : [];
      const environmentReminders = options.environmentReminders
        ? [{ packageId: "pkg", env: ["ANTHROPIC_API_KEY"] }]
        : [];
      const instructionBlocks = options.codex
        ? [
            {
              path: "/tmp/project/AGENTS.md",
              marker: { bundleId: input.bundleId, tool: input.tool },
              content: "Use review skill.",
            },
          ]
        : [];
      const tomlMerges = options.codex
        ? [
            {
              path: "/tmp/project/.codex/config.toml",
              tablePath: ["mcp_servers"],
              entries: [{ key: "github", value: { command: "npx" } }],
            },
          ]
        : [];
      return {
        plan: {
          tool: input.tool,
          bundleId: input.bundleId,
          projectRoot: "/tmp/project",
          generatedFiles: ["/tmp/project/.claude/skills/pkg-skill"],
          files: [],
          symlinks: [],
          jsonMerges: [],
          instructionBlocks,
          tomlMerges,
          hooks: [],
          skippedHooks: [],
          hookWarnings: [],
          environmentReminders,
          advisories,
          hookCandidates: [],
          hookDecisionRequired:
            hookCandidates.length > 0 && !options.adjacentHookCandidatesWithoutDecision,
          enabledAdjacentHooks: [],
        },
        symlinkPaths: ["/tmp/project/.claude/skills/pkg-skill"],
        generatedFiles: ["/tmp/project/.claude/skills/pkg-skill"],
        hookDecisionRequired:
          hookCandidates.length > 0 && !options.adjacentHookCandidatesWithoutDecision,
        instructionBlockPaths: instructionBlocks.map((block) => block.path),
        tomlMergeEntries: tomlMerges.flatMap((merge) =>
          merge.entries.map((entry) => `${merge.path} ${merge.tablePath.join(".")}.${entry.key}`)
        ),
        managedMcpKeys: [],
        mcpPreview: [],
        managedHooks: [
          {
            id: "safe-bash",
            tool: input.tool,
            required: true,
            appliesTo: ["skill:review"],
            output: ".claude/settings.json",
            risk: "executable behavior",
            drift: false,
          },
        ],
        hookCandidates,
        advisories,
      };
    },
    async applyLink(input) {
      calls.push(
        `apply:${input.bundleId}:${input.tool}:${input.overwrite === true}:${input.adjacentHooks?.mode ?? "unspecified"}:${input.allowAdvisories === true}`
      );
      return {
        plan: {
          tool: input.tool,
          bundleId: input.bundleId,
          projectRoot: "/tmp/project",
          generatedFiles: [],
          files: [],
          symlinks: [],
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
        },
        written: [],
      };
    },
    async listLinkRecords() {
      return [];
    },
    async unlink(record) {
      calls.push(`unlink:${record.id}`);
      return {
        plan: {
          tool: record.tool,
          bundleId: record.bundleId,
          projectRoot: record.projectRoot,
          generatedFiles: [],
          files: [],
          symlinks: [],
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
        },
        written: [],
      };
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function navigateToBundleDetail(app: ReturnType<typeof render>): Promise<void> {
  await waitForFrame(app, "Actions");
  app.stdin.write("5");
  await waitForFrame(app, "Create bundle");
  await flush();
  app.stdin.write("2");
  await waitForFrame(app, "Bundle: coding");
  await flush();
}

async function navigateToLinkPreview(app: ReturnType<typeof render>): Promise<void> {
  await waitForFrame(app, "Actions");
  app.stdin.write("6");
  await waitForFrame(app, "Pick bundle");
  await flush();
  app.stdin.write("1");
  await waitForFrame(app, "Pick tool");
  await flush();
  app.stdin.write("1");
  await flush();
}

async function waitForFrame(app: ReturnType<typeof render>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (app.lastFrame()?.includes(text)) return;
    await flush();
  }
  throw new Error(`Timed out waiting for frame containing: ${text}\n${app.lastFrame() ?? ""}`);
}

async function writeVirtualFormula(
  registry: string,
  id: string,
  capability = "github"
): Promise<void> {
  const [owner, repo] = id.split("/");
  await mkdir(join(registry, "formulas", owner), { recursive: true });
  await writeFile(
    join(registry, "formulas", owner, `${repo}.yaml`),
    [
      "schemaVersion: 1",
      `id: ${id}`,
      "name: Review Pack",
      "description: Code review helper",
      "source:",
      "  type: virtual",
      "  origin:",
      "    type: remote",
      "    url: https://example.com/mcp",
      "capabilities:",
      `  - id: ${capability}`,
      "    kind: mcp",
      "    description: GitHub MCP",
      "    spec:",
      `      serverName: ${capability}`,
      "      transport: remote",
      "      sourceFormat: direct",
      "      config:",
      `        url: https://example.com/${capability}`,
      "",
    ].join("\n"),
    "utf8"
  );
}

async function initGitRepo(path: string): Promise<void> {
  await git(path, "init");
  await git(path, "config", "user.email", "test@example.com");
  await git(path, "config", "user.name", "Test User");
  await git(path, "add", ".");
  await git(path, "commit", "-m", "initial");
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
