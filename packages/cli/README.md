# SAMX

SAMX is a local-first CLI for packaging, bundling, and linking AI development capabilities.

## Install

Beta:

```sh
npm install -g @c3qo/samx@beta
pnpm add -g @c3qo/samx@beta
```

Stable, after the first stable release:

```sh
npm install -g @c3qo/samx
pnpm add -g @c3qo/samx
```

## Development Pack Smoke

Build and pack the CLI from the repository root:

```sh
pnpm build
pnpm --dir packages/cli pack
```

Install the generated tarball on another machine:

```sh
pnpm add -g ./c3qo-samx-0.1.0-beta.0.tgz
samx --help
```

## Common Commands

```sh
samx registry add community https://example.test/community.git
samx registry sync community
samx search shell
samx formula show community/example/safe-bash
samx pkg install community/example/safe-bash
samx pkg install community/example/safe-bash --head --ref main
samx pkg install --local local-tools ../tools
samx pkg list
samx pkg update
samx pkg update community/example/safe-bash --head --yes
samx pkg uninstall community/example/safe-bash --force
samx capability list
samx capability list --type agent
samx bundle list
samx add community/example/safe-bash:skills-review --bundle coding --tool claude
samx remove --bundle coding --tool claude
samx remove review --bundle coding --tool claude
samx link <bundle> --tool claude --project .
samx tui
samx analyze .
```

`samx tui` opens the interactive terminal UI for package management, capability browsing, bundle creation, link preview/apply, and unlink confirmation. It requires an interactive TTY; use the regular commands in scripts.

Top-level `samx remove` with a capability id or alias removes that item from the current project bundle, unlinks current outputs, and relinks remaining items. Without an id, TTY runs prompt to select one or more bundle items; non-TTY runs print explicit candidates. Use `samx unlink <bundle> --tool <tool>` to remove all generated outputs for a linked bundle.

Formula and local packages can include skills, agents, and MCP servers using these layouts:

```text
skills/<name>/SKILL.md
agents/<name>/AGENT.md
mcp/<name>/mcp.json
```

## Package Hooks

Packages may declare executable hooks in `samx.package.json`. Hooks are package-level executable attachments to skills or agents: hook files may use any declared relative path inside the package, but SAMX applies them only when the manifest explicitly declares them.

Example manifest fragment:

```json
{
  "hooks": [
    {
      "id": "safe-bash",
      "appliesTo": ["skill:safe-bash", "agent:shell-reviewer"],
      "files": [
        { "target": "claude", "path": "hooks/safe-bash.json" },
        { "target": "opencode", "path": "hooks/safe-bash.js" }
      ],
      "required": true
    }
  ]
}
```

Claude hook files must be JSON with top-level `hooks`; SAMX merges declared Claude hooks into `.claude/settings.json`. OpenCode hook files must be `.js` or `.mjs`; SAMX links declared OpenCode hooks into `.opencode/plugins`.

Hook effects are visible before install in `samx bundle check`, `samx link --dry-run`, and the TUI link preview. SAMX records managed hook outputs when linking and unlinks only those recorded hook entries or files.

### Adjacent Hook Candidates

Package authors may place hook files next to the skill or agent they affect:

```text
skills/<name>/hooks/claude.json
skills/<name>/hooks/opencode.js
skills/<name>/hooks/opencode.mjs
agents/<name>/hooks/claude.json
agents/<name>/hooks/opencode.js
agents/<name>/hooks/opencode.mjs
```

SAMX discovers these files as hook candidates during `samx bundle check` and `samx link`. SAMX does not write `samx.package.json`. When adjacent hook candidates are present, use `--enable-hook <id>` or `--enable-hooks all` to apply candidate hook outputs, or `--no-hooks` to link without adjacent hook candidates. On relink, omitting these flags reuses the previous adjacent hook decision only when the recorded hook id, package, tool, source path, and fingerprint still exactly match current candidates.

## Notes

SAMX stores registries, formula package checkouts, local package records, bundles, and link records under `~/.samx` by default. Set `SAMX_HOME` to use a different store location.

The published package is a bundled CLI. Internal SAMX workspace packages are bundled into `dist/index.js`, and built-in scanner configuration is shipped under `dist/config/packs`.
