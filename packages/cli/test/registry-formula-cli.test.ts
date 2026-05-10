import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { runCli } from "../src/index.js";

const execFileAsync = promisify(execFile);

async function run(
  args: string[],
  samxHome: string,
  env: NodeJS.ProcessEnv = {},
  formulaGenerateFetch?: typeof fetch
) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    cwd: samxHome,
    env: { SAMX_HOME: samxHome, ...env },
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    probeRunner: async () => ({ exitCode: 0 }),
    formulaGenerateFetch,
  });

  return { exitCode, stdout, stderr };
}

test("formula generate writes formula draft using injected OpenAI fetch", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-generate-success-cli-"));
  const source = await createGitSource();
  const outputPath = join(samxHome, "formulas", "superpowers.yaml");
  const responseBody = {
    output: [
      {
        content: [
          {
            text: JSON.stringify({
              id: "superpowers",
              name: "Superpowers",
              description: "Superpowers skills.",
              capabilities: [
                {
                  id: "brainstorming",
                  kind: "skill",
                  path: "skills/brainstorming",
                  description: "Explore ideas.",
                  confidence: 0.9,
                  evidence: [{ path: "skills/brainstorming/SKILL.md", quote: "# Brainstorming" }],
                },
              ],
              requirements: { env: [] },
              requirementEvidence: [],
            }),
          },
        ],
      },
    ],
  };
  const endpoints: string[] = [];
  const formulaGenerateFetch: typeof fetch = async (url) => {
    endpoints.push(String(url));
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await run(
    [
      "formula",
      "generate",
      pathToFileURL(source).href,
      "--out",
      outputPath,
      "--endpoint",
      "https://llm.example.test/v1",
    ],
    samxHome,
    { OPENAI_API_KEY: "test-key" },
    formulaGenerateFetch
  );
  const written = await readFile(outputPath, "utf8");

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Generated formula: ${outputPath}`);
  expect(endpoints[0]).toBe("https://llm.example.test/v1/responses");
  expect(written).toContain(`id: local/${source.split("/").at(-1)!.toLowerCase()}`);
});

test("formula generate requires OPENAI_API_KEY", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-generate-cli-"));

  const result = await run(["formula", "generate", "https://example.test/source.git"], samxHome, {
    OPENAI_API_KEY: "",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("OPENAI_API_KEY is required");
});

test("formula discover-mcp writes discovery JSON using injected OpenAI fetch", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-discover-mcp-cli-"));
  const outputPath = join(samxHome, "discovery.json");
  const formulaGenerateFetch = mcpDiscoveryFetch();

  const result = await run(
    [
      "formula",
      "discover-mcp",
      "https://mcp.example.test/list",
      "--out",
      outputPath,
      "--model",
      "gpt-test",
      "--endpoint",
      "https://llm.example.test/v1",
    ],
    samxHome,
    { OPENAI_API_KEY: "test-key" },
    formulaGenerateFetch
  );
  const discovery = JSON.parse(await readFile(outputPath, "utf8"));

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Discovered MCP servers: ${outputPath}`);
  expect(discovery.servers[0].id).toBe("context7");
});

test("formula discover-mcp --json prints discovery JSON", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-discover-mcp-json-cli-"));

  const result = await run(
    ["formula", "discover-mcp", "https://mcp.example.test/list", "--json"],
    samxHome,
    { OPENAI_API_KEY: "test-key" },
    mcpDiscoveryFetch()
  );
  const discovery = JSON.parse(result.stdout);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(discovery.servers[0].id).toBe("context7");
  await expect(readFile(join(samxHome, "mcp-discovery.json"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("formula generate-mcp writes formulas from discovery JSON without API key", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-generate-mcp-cli-"));
  const discoveryPath = join(samxHome, "discovery.json");
  const outDir = join(samxHome, "formulas");
  await writeMcpDiscovery(discoveryPath);

  const result = await run(
    ["formula", "generate-mcp", discoveryPath, "--out-dir", outDir],
    samxHome,
    { OPENAI_API_KEY: "" }
  );
  const yaml = await readFile(join(outDir, "context7.example.test", "context7.yaml"), "utf8");

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("Generated MCP formulas: 1");
  expect(yaml).toContain("type: virtual");
});

test("formula generate-mcp-list discovers and writes formulas", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-generate-mcp-list-cli-"));
  const outDir = join(samxHome, "formulas");

  const result = await run(
    [
      "formula",
      "generate-mcp-list",
      "https://mcp.example.test/list",
      "--out-dir",
      outDir,
      "--model",
      "gpt-test",
    ],
    samxHome,
    { OPENAI_API_KEY: "test-key" },
    mcpDiscoveryFetch()
  );

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("Generated MCP formulas: 1");
});

test("formula generate-mcp-list passes max page bytes option", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-generate-mcp-list-max-bytes-cli-"));
  const outDir = join(samxHome, "formulas");

  const result = await run(
    [
      "formula",
      "generate-mcp-list",
      "https://mcp.example.test/list",
      "--out-dir",
      outDir,
      "--max-page-bytes",
      "2000000",
    ],
    samxHome,
    { OPENAI_API_KEY: "test-key" },
    async (url, init) => {
      if (String(url).endsWith("/responses")) {
        return new Response(
          JSON.stringify({
            output: [
              { content: [{ text: JSON.stringify({ servers: mcpDiscoveryDocument().servers }) }] },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      expect(init).toBeUndefined();
      return new Response(`Context7 remote MCP server.${"x".repeat(1_000_001)}`, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    }
  );

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("Generated MCP formulas: 1");
});

test("formula generate-mcp-list exits nonzero when discovery has no valid servers", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-generate-mcp-list-invalid-cli-"));

  const result = await run(
    ["formula", "generate-mcp-list", "https://mcp.example.test/list"],
    samxHome,
    { OPENAI_API_KEY: "test-key" },
    mcpDiscoveryFetch([{ id: "bad", config: { url: "https://bad.example.test/sse" } }])
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("No valid MCP servers discovered");
  expect(result.stderr).toContain("bad: config.type must be sse or streamable-http");
});

test("formula discover-mcp --strict exits nonzero for mixed valid and invalid candidates", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-discover-mcp-strict-cli-"));

  const result = await run(
    ["formula", "discover-mcp", "https://mcp.example.test/list", "--strict"],
    samxHome,
    { OPENAI_API_KEY: "test-key" },
    mcpDiscoveryFetch([
      ...mcpDiscoveryDocument().servers,
      { id: "bad", config: { url: "https://bad.example.test/sse" } },
    ])
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Invalid MCP discovery candidates:");
  expect(result.stderr).toContain("bad: config.type must be sse or streamable-http");
});

test("formula discover-mcp requires OPENAI_API_KEY", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-discover-mcp-key-cli-"));

  const result = await run(["formula", "discover-mcp", "https://mcp.example.test/list"], samxHome, {
    OPENAI_API_KEY: "",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("OPENAI_API_KEY is required");
});

test("formula discover-mcp help documents strict mode", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-discover-mcp-help-cli-"));

  const result = await run(["formula", "discover-mcp", "--help"], samxHome);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("--strict");
  expect(result.stdout).toContain("Fail when discovery contains invalid candidates");
});

test("manages local registries and reads formulas", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-registry-cli-"));
  await writeFormula(samxHome, "default", "example/safe-bash");

  const trust = await run(["registry", "trust", "default"], samxHome);
  const list = await run(["registry", "list"], samxHome);
  const search = await run(["search", "shell"], samxHome);
  const show = await run(["formula", "show", "example/safe-bash"], samxHome);

  expect(trust.exitCode, trust.stderr).toBe(0);
  expect(trust.stdout).toContain("Trusted registry: default");
  expect(list.exitCode, list.stderr).toBe(0);
  expect(list.stdout).toBe("Registries: 1\n* default https://github.com/c3qo/samx-registry.git\n");
  expect(search.exitCode, search.stderr).toBe(0);
  expect(search.stdout).toBe("example/safe-bash\tSafe Bash\n");
  expect(show.exitCode, show.stderr).toBe(0);
  expect(show.stdout).toBe("Safe Bash\nexample/safe-bash\n- skill lint\n");
});

test("formula validate validates a recursive formula directory", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-validate-success-cli-"));
  await writePlainFormula(
    join(samxHome, "formulas", "example", "safe-bash.yaml"),
    "example/safe-bash"
  );

  const result = await run(["formula", "validate", join(samxHome, "formulas")], samxHome);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("✅ Validated 1 formulas successfully.\n");
});

test("formula validate reports schema and path convention errors", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-validate-failure-cli-"));
  await writePlainFormula(
    join(samxHome, "formulas", "wrong", "name.yaml"),
    "example/safe-bash",
    "not-a-commit"
  );

  const result = await run(["formula", "validate", join(samxHome, "formulas")], samxHome);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    "source.revision: Git source revision must be a 40 or 64 character hex commit"
  );
  expect(result.stderr).toContain(
    "formula path must match id: expected formulas/example/safe-bash.yaml"
  );
});

test("formula validate defaults to cwd", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-validate-default-cli-"));
  await writePlainFormula(join(samxHome, "example", "safe-bash.yaml"), "example/safe-bash");

  const result = await run(["formula", "validate"], samxHome);

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("✅ Validated 1 formulas successfully.\n");
});

test("strips terminal control text from formula output", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-formula-control-cli-"));
  await writeFormula(
    samxHome,
    "default",
    "example/safe-bash",
    "https://example.test/safe-bash.git",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "\u001b[31mSafe Bash\u001b[0m"
  );

  const search = await run(["search", "safe"], samxHome);
  const show = await run(["formula", "show", "example/safe-bash"], samxHome);

  expect(search.stdout).toContain("example/safe-bash\tSafe Bash");
  expect(search.stdout).not.toContain("default/example/safe-bash");
  expect(show.stdout).toContain("Safe Bash");
  expect(show.stdout).toContain("example/safe-bash");
  expect(show.stdout).not.toContain("default/example/safe-bash");
  expect(search.stdout).not.toContain("\u001b");
  expect(show.stdout).not.toContain("\u001b");
});

test("installs formula package from local git source", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-pkg-add-formula-"));
  const source = await createGitSource();
  const revision = await gitHead(source);
  await writeFormula(samxHome, "default", "obra/superpowers", pathToFileURL(source).href, revision);
  await commitAll(join(samxHome, "registries", "default"));
  await run(["registry", "trust", "default"], samxHome);

  const add = await run(["pkg", "install", "obra/superpowers"], samxHome);
  const list = await run(["pkg", "list"], samxHome);
  const capabilities = await run(["capability", "list"], samxHome);

  expect(add.exitCode, add.stderr).toBe(0);
  expect(add.stdout).toContain("Installed package: obra/superpowers");
  expect(add.stdout).not.toContain("default/obra/superpowers");
  expect(list.stdout).toContain("obra/superpowers");
  expect(list.stdout).not.toContain("default/obra/superpowers");
  expect(capabilities.exitCode, capabilities.stderr).toBe(0);
  expect(capabilities.stdout).toContain("default/obra/superpowers:brainstorming");
});

test("bundle add and remove accept default capability shorthand", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-bundle-default-shorthand-cli-"));
  const source = await createGitSource();
  const revision = await gitHead(source);
  await writeFormula(samxHome, "default", "obra/superpowers", pathToFileURL(source).href, revision);
  await commitAll(join(samxHome, "registries", "default"));
  await run(["registry", "trust", "default"], samxHome);
  await run(["pkg", "install", "obra/superpowers"], samxHome);
  await run(["bundle", "create", "coding"], samxHome);

  const add = await run(["bundle", "add", "coding", "obra/superpowers:brainstorming"], samxHome);
  const show = await run(["bundle", "show", "coding"], samxHome);
  const remove = await run(
    ["bundle", "remove", "coding", "obra/superpowers:brainstorming"],
    samxHome
  );
  const afterRemove = await run(["bundle", "show", "coding"], samxHome);

  expect(add.exitCode, add.stderr).toBe(0);
  expect(add.stdout).toContain("Added to bundle: coding <- obra/superpowers:brainstorming");
  expect(add.stdout).not.toContain("default/obra/superpowers");
  expect(show.stdout).toContain("skill: obra/superpowers:brainstorming");
  expect(show.stdout).not.toContain("default/obra/superpowers");
  expect(remove.exitCode, remove.stderr).toBe(0);
  expect(remove.stdout).toContain("Removed from bundle: coding <- obra/superpowers:brainstorming");
  expect(afterRemove.stdout).not.toContain("brainstorming");
  const rawBundle = await readFile(join(samxHome, "bundles", "coding.yaml"), "utf8");
  expect(rawBundle).not.toContain("default/obra/superpowers:brainstorming");
});

test("bundle destroy removes a whole bundle", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-bundle-destroy-cli-"));
  await run(["bundle", "create", "coding"], samxHome);

  const destroy = await run(["bundle", "destroy", "coding"], samxHome);
  const list = await run(["bundle", "list"], samxHome);

  expect(destroy.exitCode, destroy.stderr).toBe(0);
  expect(destroy.stdout).toContain("Destroyed bundle: coding");
  expect(list.stdout).toBe("Bundles: 0\n\n");
});

test("pkg add and remove are no longer supported", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-pkg-breaking-commands-cli-"));

  const add = await run(["pkg", "add", "obra/superpowers"], samxHome);
  const remove = await run(["pkg", "remove", "obra/superpowers"], samxHome);

  expect(add.exitCode).toBe(1);
  expect(add.stderr).toContain("Unsupported pkg command: add");
  expect(remove.exitCode).toBe(1);
  expect(remove.stderr).toContain("Unsupported pkg command: remove");
});

test("pkg install shorthand resolves unique non-default registry formula", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-pkg-add-unique-registry-"));
  const source = await createGitSource();
  const revision = await gitHead(source);
  await writeFormula(samxHome, "local", "obra/superpowers", pathToFileURL(source).href, revision);
  await commitAll(join(samxHome, "registries", "local"));
  await run(["registry", "add", "local", "file:///tmp/local.git", "--no-clone"], samxHome);
  await run(["registry", "trust", "local"], samxHome);

  const add = await run(["pkg", "install", "obra/superpowers"], samxHome);
  const capabilities = await run(["capability", "list"], samxHome);

  expect(add.exitCode, add.stderr).toBe(0);
  expect(add.stdout).toContain("Installed package: local/obra/superpowers");
  expect(capabilities.stdout).toContain("local/obra/superpowers:brainstorming");
});

test("pkg install shorthand reports registry conflicts", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-pkg-add-conflict-registry-"));
  await writeFormula(samxHome, "default", "obra/superpowers");
  await writeFormula(samxHome, "local", "obra/superpowers");
  await run(["registry", "add", "local", "https://example.test/local.git", "--no-clone"], samxHome);

  const add = await run(["pkg", "install", "obra/superpowers"], samxHome);

  expect(add.exitCode).toBe(1);
  expect(add.stderr).toContain("Ambiguous formula id: obra/superpowers");
  expect(add.stderr).toContain("- default/obra/superpowers");
  expect(add.stderr).toContain("- local/obra/superpowers");
});

test("bundle add shorthand resolves unique non-default capability", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-bundle-unique-registry-"));
  const source = await createGitSource();
  const revision = await gitHead(source);
  await writeFormula(samxHome, "local", "obra/superpowers", pathToFileURL(source).href, revision);
  await commitAll(join(samxHome, "registries", "local"));
  await run(["registry", "add", "local", "file:///tmp/local.git", "--no-clone"], samxHome);
  await run(["registry", "trust", "local"], samxHome);
  await run(["pkg", "install", "local/obra/superpowers"], samxHome);
  await run(["bundle", "create", "coding"], samxHome);

  const add = await run(["bundle", "add", "coding", "obra/superpowers:brainstorming"], samxHome);
  const show = await run(["bundle", "show", "coding"], samxHome);

  expect(add.exitCode, add.stderr).toBe(0);
  expect(add.stdout).toContain("Added to bundle: coding <- local/obra/superpowers:brainstorming");
  expect(show.stdout).toContain("skill: local/obra/superpowers:brainstorming");
});

test("bundle add shorthand reports capability conflicts", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-bundle-conflict-registry-"));
  await writeFile(
    join(samxHome, "index.json"),
    JSON.stringify({
      capabilities: [
        {
          id: "default/obra/superpowers:brainstorming",
          packageId: "default/obra/superpowers",
          name: "brainstorming",
          kind: "skill",
          path: "/tmp/default",
        },
        {
          id: "local/obra/superpowers:brainstorming",
          packageId: "local/obra/superpowers",
          name: "brainstorming",
          kind: "skill",
          path: "/tmp/local",
        },
      ],
    }),
    "utf8"
  );
  await run(["bundle", "create", "coding"], samxHome);

  const add = await run(["bundle", "add", "coding", "obra/superpowers:brainstorming"], samxHome);

  expect(add.exitCode).toBe(1);
  expect(add.stderr).toContain("Ambiguous capability id: obra/superpowers:brainstorming");
  expect(add.stderr).toContain("- default/obra/superpowers:brainstorming");
  expect(add.stderr).toContain("- local/obra/superpowers:brainstorming");
});

test("search shows default and custom registry formula matches distinctly", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-search-duplicate-registry-cli-"));
  await writeFormula(samxHome, "default", "obra/superpowers");
  await writeFormula(samxHome, "local", "obra/superpowers");
  await run(["registry", "add", "local", "https://example.test/local.git", "--no-clone"], samxHome);

  const search = await run(["search", "superpowers"], samxHome);

  expect(search.exitCode, search.stderr).toBe(0);
  expect(search.stdout).toContain("obra/superpowers\tSafe Bash");
  expect(search.stdout).toContain("local/obra/superpowers\tSafe Bash");
  expect(search.stdout).not.toContain("default/obra/superpowers");
});

test("registry list includes built-in default registry", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-registry-default-cli-"));

  const list = await run(["registry", "list"], samxHome);

  expect(list.exitCode, list.stderr).toBe(0);
  expect(list.stdout).toBe("Registries: 1\n- default https://github.com/c3qo/samx-registry.git\n");
});

test("removes registry from CLI store", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-registry-remove-cli-"));
  await run(["registry", "add", "alpha", "https://example.test/alpha.git", "--no-clone"], samxHome);
  await run(["registry", "add", "beta", "https://example.test/beta.git", "--no-clone"], samxHome);

  const remove = await run(["registry", "remove", "alpha"], samxHome);
  const list = await run(["registry", "list"], samxHome);

  expect(remove.exitCode, remove.stderr).toBe(0);
  expect(remove.stdout).toContain("Removed registry: alpha");
  expect(list.stdout).not.toContain("alpha https://example.test/alpha.git");
  expect(list.stdout).toContain("default https://github.com/c3qo/samx-registry.git");
  expect(list.stdout).toContain("beta https://example.test/beta.git");
});

test("rejects removing built-in default registry from CLI", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-registry-remove-default-cli-"));

  const remove = await run(["registry", "remove", "default", "--force"], samxHome);

  expect(remove.exitCode).toBe(1);
  expect(remove.stderr).toContain("Cannot remove built-in registry: default");
});

test("force removes registry while installed packages remain", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-registry-remove-force-cli-"));
  const source = await createGitSource();
  const revision = await gitHead(source);
  await writeFormula(samxHome, "local", "obra/superpowers", pathToFileURL(source).href, revision);
  await commitAll(join(samxHome, "registries", "local"));
  await run(["registry", "add", "local", "file:///tmp/local.git", "--no-clone"], samxHome);
  await run(["pkg", "install", "local/obra/superpowers"], samxHome);

  const remove = await run(["registry", "remove", "local", "--force"], samxHome);
  const packages = await run(["pkg", "list"], samxHome);

  expect(remove.exitCode, remove.stderr).toBe(0);
  expect(remove.stdout).toContain("Removed registry: local");
  expect(remove.stdout).toContain(
    "Installed packages from this registry remain installed and cannot be updated until the registry is added again."
  );
  expect(packages.stdout).toContain("obra/superpowers");
});

test("virtual MCP formula links remote OpenCode config", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-virtual-mcp-cli-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "samx-virtual-mcp-project-"));
  await writeVirtualMcpFormula(samxHome, "default", "example/weather-mcp");
  await commitAll(join(samxHome, "registries", "default"));
  const add = await run(["pkg", "install", "example/weather-mcp"], samxHome);
  const capabilities = await run(["capability", "list", "--type", "mcp"], samxHome);
  const createBundle = await run(["bundle", "create", "weather"], samxHome);
  const addBundle = await run(
    ["bundle", "add", "weather", "default/example/weather-mcp:weather-service"],
    samxHome
  );
  const link = await run(
    ["link", "weather", "--tool", "opencode", "--project", projectRoot],
    samxHome
  );

  expect(add.exitCode, add.stderr).toBe(0);
  expect(capabilities.exitCode, capabilities.stderr).toBe(0);
  expect(capabilities.stdout).toContain("default/example/weather-mcp:weather-service");
  expect(createBundle.exitCode, createBundle.stderr).toBe(0);
  expect(addBundle.exitCode, addBundle.stderr).toBe(0);
  expect(link.exitCode, link.stderr).toBe(0);
  const opencode = JSON.parse(
    await readFile(join(projectRoot, ".opencode", "opencode.json"), "utf8")
  );
  expect(opencode.mcp["example-weather-mcp-weather"]).toEqual({
    type: "remote",
    url: "https://weather-mcp.example.com/sse",
  });
});

test("adds formula package from source head and updates with preview confirmation", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-pkg-head-cli-"));
  const source = await createGitSourceWithTwoCommits();
  await writeFormula(
    samxHome,
    "default",
    "obra/superpowers",
    pathToFileURL(source.path).href,
    source.first
  );
  await commitAll(join(samxHome, "registries", "default"));
  await run(["registry", "trust", "default"], samxHome);

  const add = await run(["pkg", "install", "obra/superpowers", "--head"], samxHome);
  const recipe = JSON.parse(
    await readFile(
      join(samxHome, "packages", "default", "obra", "superpowers", "recipe.lock.json"),
      "utf8"
    )
  );
  const preview = await run(["pkg", "update", "obra/superpowers", "--head"], samxHome);
  const update = await run(["pkg", "update", "obra/superpowers", "--head", "--yes"], samxHome);

  expect(add.exitCode, add.stderr).toBe(0);
  expect(recipe.source.revision).toBe(source.second);
  expect(preview.exitCode, preview.stderr).toBe(0);
  expect(preview.stdout).toContain("Packages already up to date: 1");
  expect(preview.stdout).toContain("obra/superpowers");
  expect(preview.stdout).not.toContain("default/obra/superpowers");
  expect(update.exitCode, update.stderr).toBe(0);
  expect(update.stdout).toContain("Updated packages: 1");
});

test("rejects source ref without source head", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-pkg-ref-cli-"));

  const result = await run(["pkg", "install", "obra/superpowers", "--ref", "main"], samxHome);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("--ref requires --head");
});

test("installs local package from CLI", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-local-pkg-cli-"));
  const source = await mkdtemp(join(tmpdir(), "samx-local-pkg-source-"));
  await mkdir(join(source, "skills", "review"), { recursive: true });
  await writeFile(
    join(source, "skills", "review", "SKILL.md"),
    "# Review\n\nReview code.\n",
    "utf8"
  );

  const add = await run(["pkg", "install", "--local", "local-tools", source], samxHome);
  const capabilities = await run(["capability", "list"], samxHome);

  expect(add.exitCode, add.stderr).toBe(0);
  expect(add.stdout).toContain("Installed local package: local-tools");
  expect(capabilities.exitCode, capabilities.stderr).toBe(0);
  expect(capabilities.stdout).toContain("local-tools:skills-review");
});

test("force uninstalls local package from CLI", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-local-remove-cli-"));
  const source = await mkdtemp(join(tmpdir(), "samx-local-remove-source-"));
  await mkdir(join(source, "skills", "review"), { recursive: true });
  await writeFile(join(source, "skills", "review", "SKILL.md"), "# Review\n", "utf8");
  await run(["pkg", "install", "--local", "local-tools", source], samxHome);

  const remove = await run(["pkg", "uninstall", "local-tools", "--force"], samxHome);
  const list = await run(["pkg", "list"], samxHome);

  expect(remove.exitCode, remove.stderr).toBe(0);
  expect(remove.stdout).toContain("Uninstalled package: local-tools");
  expect(list.stdout).toBe("Packages: 0\n\n");
});

test("does not record registry when clone fails", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-registry-clone-fail-"));

  const result = await run(["registry", "add", "broken", join(samxHome, "missing.git")], samxHome);

  expect(result.exitCode).toBe(1);
  await expect(readFile(join(samxHome, "registries.json"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("pkg update requires --yes before mutating packages", async () => {
  const samxHome = await mkdtemp(join(tmpdir(), "samx-pkg-update-confirm-"));
  await writeFormula(samxHome, "local", "example/safe-bash");
  await writeFile(
    join(samxHome, "registries.json"),
    JSON.stringify({ registries: [{ id: "local", url: "https://example.test/local.git" }] }),
    "utf8"
  );
  await mkdir(join(samxHome, "packages", "local", "example", "safe-bash"), { recursive: true });
  await writeFile(
    join(samxHome, "packages", "local", "example", "safe-bash", "recipe.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "local/example/safe-bash",
      formula: {
        registry: "local",
        path: "formulas/example/safe-bash.yaml",
        registryUrl: "https://example.test/local.git",
        registryCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        formulaHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      source: {
        type: "git",
        url: "https://example.test/safe-bash.git",
        revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      capabilities: [
        {
          id: "local/example/safe-bash:lint",
          formulaCapabilityId: "lint",
          kind: "skill",
          path: "skills/lint",
        },
      ],
    }),
    "utf8"
  );
  await writeFile(
    join(samxHome, "samx.lock"),
    JSON.stringify({
      schemaVersion: 1,
      trustedRegistries: [],
      registries: {
        local: {
          url: "https://example.test/local.git",
          commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
      formulas: [
        {
          id: "local/example/safe-bash",
          formulaPath: "formulas/example/safe-bash.yaml",
          formulaHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
          source: {
            type: "git",
            url: "https://example.test/safe-bash.git",
            revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          capabilities: ["local/example/safe-bash:lint"],
        },
      ],
    }),
    "utf8"
  );
  await writeFormula(
    samxHome,
    "local",
    "example/safe-bash",
    "https://example.test/safe-bash.git",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  );

  const preview = await run(["pkg", "update"], samxHome);

  expect(preview.exitCode, preview.stderr).toBe(0);
  expect(preview.stdout).toContain("Would update packages: 1");
  expect(preview.stdout).toContain(
    "source.revision: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -> bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  );
  expect(preview.stdout).toContain("Run with --yes to apply");
});

async function writeFormula(
  root: string,
  registry: string,
  formula: string,
  sourceUrl = `https://example.test/${formula}.git`,
  revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  name = "Safe Bash"
): Promise<void> {
  await mkdir(
    join(root, "registries", registry, "formulas", formula.split("/").slice(0, -1).join("/")),
    { recursive: true }
  );
  await writeFile(
    join(root, "registries", registry, "formulas", `${formula}.yaml`),
    `schemaVersion: 1
id: ${formula}
name: ${name}
description: Safe shell workflows
source:
  type: git
  url: ${sourceUrl}
  revision: ${revision}
capabilities:
  - id: ${formula.endsWith("/superpowers") ? "brainstorming" : "lint"}
    kind: skill
    path: skills/${formula.endsWith("/superpowers") ? "brainstorming" : "lint"}
`,
    "utf8"
  );
}

async function writePlainFormula(
  path: string,
  formula: string,
  revision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
): Promise<void> {
  await mkdir(path.split("/").slice(0, -1).join("/"), { recursive: true });
  await writeFile(
    path,
    `schemaVersion: 1
id: ${formula}
name: Safe Bash
source:
  type: git
  url: https://example.test/${formula}.git
  revision: ${revision}
capabilities:
  - id: lint
    kind: skill
    path: skills/lint
`,
    "utf8"
  );
}

async function writeVirtualMcpFormula(
  root: string,
  registry: string,
  formula: string
): Promise<void> {
  await mkdir(
    join(root, "registries", registry, "formulas", formula.split("/").slice(0, -1).join("/")),
    { recursive: true }
  );
  await writeFile(
    join(root, "registries", registry, "formulas", `${formula}.yaml`),
    `schemaVersion: 1
id: ${formula}
name: Weather MCP
description: Hosted weather MCP server
source:
  type: virtual
  origin:
    type: remote
    url: 'https://weather-mcp.example.com/sse'
capabilities:
  - id: weather-service
    kind: mcp
    description: Hosted weather data over SSE.
    spec:
      serverName: weather
      transport: remote
      sourceFormat: direct
      config:
        type: sse
        url: 'https://weather-mcp.example.com/sse'
`,
    "utf8"
  );
}

async function writeMcpDiscovery(path: string): Promise<void> {
  await writeFile(path, JSON.stringify(mcpDiscoveryDocument(), null, 2), "utf8");
}

function mcpDiscoveryFetch(servers: unknown[] = mcpDiscoveryDocument().servers): typeof fetch {
  return async (url, init) => {
    if (String(url).endsWith("/responses")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.model).toBeDefined();
      return new Response(
        JSON.stringify({
          output: [{ content: [{ text: JSON.stringify({ servers }) }] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("<title>MCP List</title>Context7 remote MCP server.", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  };
}

function mcpDiscoveryDocument() {
  return {
    schemaVersion: 1,
    source: { type: "web", url: "https://mcp.example.test/list" },
    pages: [
      { url: "https://mcp.example.test/list", title: "MCP List", contentHash: "sha256:test" },
    ],
    servers: [
      {
        id: "context7",
        name: "Context7",
        description: "Context7 remote MCP server.",
        serverName: "context7",
        config: { type: "sse", url: "https://context7.example.test/sse" },
        evidence: [{ url: "https://mcp.example.test/list", quote: "Context7 remote MCP server." }],
      },
    ],
    invalidCandidates: [],
    diagnostics: [],
  };
}

async function createGitSource(): Promise<string> {
  const source = await mkdtemp(join(tmpdir(), "samx-formula-source-"));
  await mkdir(join(source, "skills", "brainstorming"), { recursive: true });
  await writeFile(
    join(source, "skills", "brainstorming", "SKILL.md"),
    "# Brainstorming\n\nExplore ideas.\n",
    "utf8"
  );
  await commitAll(source);
  return source;
}

async function createGitSourceWithTwoCommits(): Promise<{
  path: string;
  first: string;
  second: string;
}> {
  const source = await createGitSource();
  const { stdout: first } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source });
  await writeFile(
    join(source, "skills", "brainstorming", "SKILL.md"),
    "# Brainstorming\n\nLatest ideas.\n",
    "utf8"
  );
  await execFileAsync("git", ["add", "."], { cwd: source });
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "latest"],
    { cwd: source }
  );
  await execFileAsync("git", ["tag", "v2"], { cwd: source });
  const { stdout: second } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: source });
  return { path: source, first: first.trim(), second: second.trim() };
}

async function commitAll(cwd: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.test", "add", "."],
    { cwd }
  );
  await execFileAsync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "source"],
    { cwd }
  );
}

async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}
