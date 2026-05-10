# SAMX CLI Commands

This is the current command surface for the `samx` CLI. It is intended as a full reference and a manual smoke-test checklist source.

Link targets: `claude`, `codex`, `opencode`, `kiro`.

Global option:

```sh
samx --no-update-check <command>
```

## Top Level

```sh
samx --help
samx analyze [path]
samx registry <command>
samx formula <command>
samx search <query>
samx pkg <command>
samx capability <command>
samx bundle <command>
samx add <formula | capability-id>
samx remove [capability-id | alias]
samx link <bundle-id>
samx unlink <bundle-id>
samx tui
```

## Analyze

Analyze existing local AI config such as Claude, OpenCode, Cursor, Kiro, and MCP files.

```sh
samx analyze [path]
samx analyze [path] --project
samx analyze [path] --home
samx analyze [path] --all
samx analyze [path] --paths
samx analyze [path] --inventory
samx analyze [path] --show <item-id>
samx analyze [path] --json
samx analyze [path] --format json
samx analyze [path] --format markdown
samx analyze [path] --security-report <path>
```

Common examples:

```sh
samx analyze .
samx analyze . --inventory
samx analyze . --show claude
samx analyze . --format markdown
```

## Registries

Manage formula registries.

```sh
samx registry add <registry-id> <url>
samx registry add <registry-id> <url> --no-clone
samx registry trust <registry-id>
samx registry sync
samx registry sync <registry-id>
samx registry list
samx registry remove <registry-id>
samx registry remove <registry-id> --force
```

Notes:

- The built-in `default` registry cannot be removed or replaced.
- `samx registry sync` with no id syncs all registries, including `default`.
- `--force` on remove leaves installed packages, bundles, and links untouched.

## Formulas

Generate, discover, and inspect formula metadata.

```sh
samx formula generate <repo-url>
samx formula generate <repo-url> --ref <name>
samx formula generate <repo-url> --out <path>
samx formula generate <repo-url> --model <name>
samx formula generate <repo-url> --endpoint <api-base-url>
samx formula generate <repo-url> --json
samx formula generate <repo-url> --force
```

```sh
samx formula discover-mcp <url>
samx formula discover-mcp <url> --out <path>
samx formula discover-mcp <url> --model <name>
samx formula discover-mcp <url> --endpoint <api-base-url>
samx formula discover-mcp <url> --crawl-depth <count>
samx formula discover-mcp <url> --max-pages <count>
samx formula discover-mcp <url> --max-page-bytes <bytes>
samx formula discover-mcp <url> --json
samx formula discover-mcp <url> --strict
```

```sh
samx formula generate-mcp <json>
samx formula generate-mcp <json> --out-dir <path>
samx formula generate-mcp <json> --namespace <name>
samx formula generate-mcp <json> --strict
samx formula generate-mcp <json> --force
```

```sh
samx formula generate-mcp-list <url>
samx formula generate-mcp-list <url> --out-dir <path>
samx formula generate-mcp-list <url> --namespace <name>
samx formula generate-mcp-list <url> --model <name>
samx formula generate-mcp-list <url> --endpoint <api-base-url>
samx formula generate-mcp-list <url> --crawl-depth <count>
samx formula generate-mcp-list <url> --max-pages <count>
samx formula generate-mcp-list <url> --max-page-bytes <bytes>
samx formula generate-mcp-list <url> --strict
samx formula generate-mcp-list <url> --force
```

```sh
samx formula show <formula>
```

Notes:

- Formula generation commands require `OPENAI_API_KEY`.
- `--endpoint` is an OpenAI-compatible API base URL, such as `http://host:port/v1`; do not include `/responses`.

## Search

Search local registry formulas.

```sh
samx search <query>
```

## Packages

Install, update, list, and uninstall formula or local packages.

```sh
samx pkg install <formula>
samx pkg install <formula> --head
samx pkg install <formula> --head --ref <name>
samx pkg install --local <local-package-id> <path>
```

```sh
samx pkg update
samx pkg update <formula>
samx pkg update --head
samx pkg update --head --ref <name>
samx pkg update --yes
samx pkg update <formula> --head --ref <name> --yes
```

```sh
samx pkg list
samx pkg uninstall <package-id>
samx pkg uninstall <package-id> --force
```

Notes:

- `--ref` requires `--head`.
- Plain `pkg update` previews changes; add `--yes` to apply.
- Formula package ids may be shown with or without the `default/` registry prefix depending on context.
- Local package ids are unscoped ids created with `samx pkg install --local`.

## Capabilities

Browse indexed skills, agents, and MCP servers.

```sh
samx capability list
samx capability list --type skill
samx capability list --type agent
samx capability list --type mcp
samx capability show <capability-id>
```

Capability id examples:

```text
default/owner/repo:skills-review
owner/repo:skills-review
local-tools:agents-reviewer
local-tools:mcp-github
```

## Bundles

Create and manage capability bundles.

```sh
samx bundle create <bundle-id>
samx bundle add <bundle-id> <capability-id>
samx bundle add <bundle-id> <capability-id> --as <alias>
samx bundle remove <bundle-id> <capability-id>
samx bundle destroy <bundle-id>
samx bundle show <bundle-id>
samx bundle list
```

Check whether a bundle can link to a target tool:

```sh
samx bundle check <bundle-id> --tool claude
samx bundle check <bundle-id> --tool codex
samx bundle check <bundle-id> --tool opencode
samx bundle check <bundle-id> --tool kiro
```

Notes:

- `generic-markdown` is not a valid `samx link` target.

## Project Add And Remove

Top-level `add` and `remove` are project-level porcelain commands. They choose or create a project bundle, then link or relink that bundle into the selected tool.

```sh
samx add <formula>
samx add <capability-id>
samx add <formula | capability-id> --as <alias>
samx add <formula | capability-id> --bundle <bundle-id>
samx add <formula | capability-id> --tool <tool>
samx add <formula | capability-id> --dry-run
samx add <formula | capability-id> --overwrite
samx add <formula | capability-id> --allow-advisories
```

```sh
samx remove
samx remove <capability-id>
samx remove <alias>
samx remove [capability-id | alias] --bundle <bundle-id>
samx remove [capability-id | alias] --tool <tool>
samx remove [capability-id | alias] --dry-run
samx remove [capability-id | alias] --overwrite
samx remove [capability-id | alias] --allow-advisories
```

Examples:

```sh
samx add stripe/ai --bundle coding --tool claude
samx add obra/superpowers:skills-code-review --bundle coding --tool opencode
samx add default/obra/superpowers:agents-reviewer --as reviewer --bundle coding --tool claude
samx remove --bundle coding --tool claude
samx remove obra/superpowers:skills-code-review --bundle coding --tool opencode
samx remove reviewer --bundle coding --tool claude
```

Notes:

- With no `--bundle`, only bundles already linked to the current project count as project bundles.
- If no project bundle exists, `samx add` creates one from the current directory name.
- If multiple project bundles exist, TTY runs prompt; non-TTY runs require `--bundle`.
- `samx remove` never uninstalls package cache.

## Link And Unlink

Link a bundle into an agent tool by creating SAMX-managed outputs.

```sh
samx link <bundle-id> --tool claude
samx link <bundle-id> --tool codex
samx link <bundle-id> --tool opencode
samx link <bundle-id> --tool kiro
samx link <bundle-id> --tool <tool> --project <path>
samx link <bundle-id> --tool <tool> --dry-run
samx link <bundle-id> --tool <tool> --overwrite
samx link <bundle-id> --tool <tool> --no-hooks
samx link <bundle-id> --tool <tool> --allow-advisories
```

Deprecated hook flags accepted for compatibility:

```sh
samx link <bundle-id> --tool <tool> --enable-hook <hook-id>
samx link <bundle-id> --tool <tool> --enable-hooks <mode>
```

Remove SAMX-managed linked outputs for a bundle and tool.

```sh
samx unlink <bundle-id> --tool claude
samx unlink <bundle-id> --tool codex
samx unlink <bundle-id> --tool opencode
samx unlink <bundle-id> --tool kiro
samx unlink <bundle-id> --tool <tool> --project <path>
samx unlink <bundle-id> --tool <tool> --dry-run
```

Notes:

- `samx link` and `samx unlink` require `--tool`.
- `--project` defaults to the current directory.
- Formula advisories block link apply unless `--allow-advisories` is passed.
- OpenCode hooks link by default; use `--no-hooks` to skip hooks.

Codex outputs:

- skills: `.agents/skills/<name>`
- agents: `AGENTS.md` managed section
- mcp: `.codex/config.toml` `[mcp_servers]`

## TUI

Open the interactive terminal UI.

```sh
samx tui
samx tui --help
```

Notes:

- `samx tui` requires an interactive TTY.
- `samx tui --help` prints help without launching Ink.

## Manual Smoke Flow

This flow exercises local package install, capability indexing, bundle operations, link preview/apply, and unlink cleanup.

```sh
export SAMX_HOME="$(mktemp -d)"
export TEST_PKG="$(mktemp -d)"
export TEST_PROJECT="$(mktemp -d)"

mkdir -p "$TEST_PKG/skills/review"
mkdir -p "$TEST_PKG/agents/reviewer"
mkdir -p "$TEST_PKG/mcp/github"
```

Create a skill:

```sh
cat > "$TEST_PKG/skills/review/SKILL.md" <<'EOF'
# Review

Review code changes safely.
EOF
```

Create an agent:

```sh
cat > "$TEST_PKG/agents/reviewer/AGENT.md" <<'EOF'
# Reviewer

You review code for bugs, regressions, and missing tests.
EOF
```

Create an MCP config:

```sh
cat > "$TEST_PKG/mcp/github/mcp.json" <<'EOF'
{
  "command": "node",
  "args": ["github-server.js"],
  "env": {
    "GITHUB_TOKEN": "${GITHUB_TOKEN}"
  }
}
EOF
```

Install and inspect:

```sh
samx pkg install --local test-pack "$TEST_PKG"
samx pkg list
samx capability list
samx capability list --type skill
samx capability list --type agent
samx capability list --type mcp
```

Expected local capability ids:

```text
test-pack:skills-review
test-pack:agents-reviewer
test-pack:mcp-github
```

Create and link a mixed bundle to OpenCode:

```sh
samx bundle create mixed-test
samx bundle add mixed-test test-pack:skills-review
samx bundle add mixed-test test-pack:agents-reviewer
samx bundle add mixed-test test-pack:mcp-github
samx bundle show mixed-test
samx bundle check mixed-test --tool opencode
samx link mixed-test --tool opencode --project "$TEST_PROJECT" --dry-run
samx link mixed-test --tool opencode --project "$TEST_PROJECT"
```

Verify OpenCode outputs:

```sh
ls -la "$TEST_PROJECT/.opencode/skills"
ls -la "$TEST_PROJECT/.opencode/agents"
cat "$TEST_PROJECT/.opencode/opencode.json"
```

Unlink:

```sh
samx unlink mixed-test --tool opencode --project "$TEST_PROJECT" --dry-run
samx unlink mixed-test --tool opencode --project "$TEST_PROJECT"
```

## Built CLI Smoke

Build before testing local source changes:

```sh
pnpm build
SAMX_HOME="$SAMX_HOME" pnpm --filter @c3qo/samx exec samx capability list
SAMX_HOME="$SAMX_HOME" pnpm --filter @c3qo/samx exec samx bundle check mixed-test --tool opencode
```

Optional target checks:

```sh
samx bundle check mixed-test --tool claude
samx bundle check mixed-test --tool codex
samx bundle check mixed-test --tool kiro
samx link mixed-test --tool claude --project "$TEST_PROJECT" --dry-run
samx link mixed-test --tool codex --project "$TEST_PROJECT" --dry-run
samx link mixed-test --tool kiro --project "$TEST_PROJECT" --dry-run
```
