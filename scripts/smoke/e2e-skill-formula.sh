#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="$ROOT_DIR/scripts/smoke/fixtures/e2e-skill-package"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
TEST_ROOT="${SAMX_SMOKE_ROOT:-$HOME/Developer/samx-test}"
RUN_ROOT="$TEST_ROOT/run_$TIMESTAMP"
LOG_FILE="$TEST_ROOT/smoke_log_$TIMESTAMP.md"
SAMX_HOME="$RUN_ROOT/samx-home"
TEST_PROJECT="$RUN_ROOT/project"
SOURCE_REPO="$RUN_ROOT/source"
REGISTRY_REPO="$RUN_ROOT/registry"
DEFAULT_REGISTRY_FORMULA_DIR="$SAMX_HOME/registries/default/formulas/stripe"

export SAMX_HOME

fail() {
  printf 'SAMX E2E smoke failed: %s\nLog: %s\n' "$1" "$LOG_FILE" >&2
  exit 1
}

append_log() {
  printf '%s\n' "$*" >>"$LOG_FILE"
}

run_cmd() {
  local title="$1"
  shift
  local output
  append_log "## $title"
  append_log ""
  append_log '```sh'
  append_log "$*"
  append_log '```'
  append_log ""
  append_log '```text'
  if ! output="$($@ 2>&1)"; then
    append_log "$output"
    append_log '```'
    fail "command failed: $*"
  fi
  append_log "$output"
  append_log '```'
  append_log ""
  printf '%s' "$output"
}

samx() {
  SAMX_HOME="$SAMX_HOME" pnpm --dir "$ROOT_DIR" --filter samx exec samx "$@"
}

run_samx() {
  local title="$1"
  shift
  run_cmd "$title" samx "$@"
}

run_samx_at() {
  local title="$1"
  local cwd="$2"
  shift 2
  run_cmd "$title" env INIT_CWD="$cwd" PWD="$cwd" SAMX_HOME="$SAMX_HOME" pnpm --dir "$ROOT_DIR" --filter samx exec samx "$@"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then
    fail "expected output to contain: $needle"
  fi
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  grep -q "$needle" "$file" || fail "expected $file to contain: $needle"
}

assert_missing() {
  local path="$1"
  [[ ! -e "$path" && ! -L "$path" ]] || fail "expected path to be removed: $path"
}

git_init_commit() {
  local repo="$1"
  local message="$2"
  git -C "$repo" init -b main >/dev/null
  git -C "$repo" config user.email test@example.test
  git -C "$repo" config user.name Test
  git -C "$repo" add .
  git -C "$repo" commit -m "$message" >/dev/null
}

mkdir -p "$TEST_ROOT" "$RUN_ROOT" "$SAMX_HOME" "$TEST_PROJECT" "$SOURCE_REPO" "$REGISTRY_REPO/formulas/e2e"

cat >"$LOG_FILE" <<EOF
# SAMX Smoke Log

Started: $TIMESTAMP
Repository: $ROOT_DIR
Run root: $RUN_ROOT
SAMX_HOME: $SAMX_HOME

## Command Coverage

Real command coverage:

- samx --help
- samx --no-update-check --help
- samx analyze
- samx analyze --paths
- samx analyze --inventory
- samx analyze --json
- samx analyze --format markdown
- samx registry add
- samx registry trust
- samx registry sync
- samx registry sync <id>
- samx registry list
- samx registry remove --force
- samx search
- samx formula show
- samx formula validate
- samx search stripe/ai from default registry
- samx formula show stripe/ai from default registry
- samx pkg install --local
- samx pkg install <formula>
- samx pkg install stripe/ai from default registry
- samx pkg update --head
- samx pkg update --head --ref <name> --yes
- samx pkg list
- samx pkg uninstall --force
- samx capability list
- samx capability list --type skill
- samx capability list --type agent
- samx capability list --type mcp
- samx capability show
- samx bundle create
- samx bundle add
- samx bundle add --as
- samx bundle remove
- samx bundle destroy
- samx bundle show
- samx bundle list
- samx bundle check --tool opencode
- samx bundle check --tool claude
- samx bundle check --tool codex
- samx bundle check --tool kiro
- samx add --dry-run
- samx add stripe/ai:mcp-stripe from default registry
- samx remove --dry-run
- samx remove stripe/ai:mcp-stripe from default registry
- samx link --tool opencode --dry-run
- samx link --tool opencode --no-hooks --dry-run
- samx link --tool opencode
- samx link --tool claude --dry-run
- samx link --tool codex --dry-run
- samx link --tool kiro --dry-run
- samx unlink --tool opencode --dry-run
- samx unlink --tool opencode

Help-only coverage:

- samx formula --help
- samx formula generate --help
- samx formula discover-mcp --help
- samx formula generate-mcp --help
- samx formula generate-mcp-list --help
- samx formula validate --help
- samx tui --help

EOF

printf 'Building SAMX CLI...\n'
run_cmd 'Build SAMX CLI' pnpm --dir "$ROOT_DIR" build >/dev/null

cp -R "$FIXTURE_DIR"/. "$SOURCE_REPO"/
git_init_commit "$SOURCE_REPO" "first source"
FIRST_SOURCE_REVISION="$(git -C "$SOURCE_REPO" rev-parse HEAD)"

cat >"$REGISTRY_REPO/formulas/e2e/e2e-skill.yaml" <<EOF
schemaVersion: 1
id: e2e/e2e-skill
name: E2E Skill
description: Local skill for SAMX formula registry smoke testing.
source:
  type: git
  url: file://$SOURCE_REPO
  ref: main
  revision: $FIRST_SOURCE_REVISION
capabilities:
  - id: e2e-skill
    kind: skill
    path: skills/e2e-skill
  - id: e2e-agent
    kind: agent
    path: agents/e2e-agent
  - id: e2e-mcp
    kind: mcp
    path: mcp/e2e-mcp
EOF
git_init_commit "$REGISTRY_REPO" "formula"

write_default_stripe_formula() {
  mkdir -p "$DEFAULT_REGISTRY_FORMULA_DIR"
  cat >"$DEFAULT_REGISTRY_FORMULA_DIR/ai.yaml" <<EOF
schemaVersion: 1
id: stripe/ai
name: Stripe AI
description: Default registry smoke formula for top-level add/remove flows.
source:
  type: virtual
  origin:
    type: remote
    url: https://docs.stripe.com/ai
capabilities:
  - id: mcp-stripe
    kind: mcp
    spec:
      serverName: stripe
      transport: remote
      sourceFormat: direct
      config:
        type: streamable-http
        url: https://mcp.stripe.com/mcp
EOF
}

printf 'Testing help commands...\n'
HELP_OUTPUT="$(run_samx 'samx --help' --help)"
assert_contains "$HELP_OUTPUT" "analyze"
assert_contains "$HELP_OUTPUT" "registry"
assert_contains "$HELP_OUTPUT" "formula"
assert_contains "$HELP_OUTPUT" "tui"
NO_UPDATE_HELP="$(run_samx 'samx --no-update-check --help' --no-update-check --help)"
assert_contains "$NO_UPDATE_HELP" "samx"
run_samx 'samx formula --help' formula --help >/dev/null
run_samx 'samx formula generate --help' formula generate --help >/dev/null
run_samx 'samx formula discover-mcp --help' formula discover-mcp --help >/dev/null
run_samx 'samx formula generate-mcp --help' formula generate-mcp --help >/dev/null
run_samx 'samx formula generate-mcp-list --help' formula generate-mcp-list --help >/dev/null
run_samx 'samx formula validate --help' formula validate --help >/dev/null
run_samx 'samx tui --help' tui --help >/dev/null

printf 'Testing analyze commands...\n'
mkdir -p "$TEST_PROJECT/.opencode/skills/manual"
cat >"$TEST_PROJECT/.opencode/skills/manual/SKILL.md" <<'EOF'
# Manual

Manual smoke skill.
EOF
ANALYZE_OUTPUT="$(run_samx 'samx analyze project' analyze "$TEST_PROJECT")"
assert_contains "$ANALYZE_OUTPUT" "SAMX Report"
run_samx 'samx analyze --paths' analyze "$TEST_PROJECT" --paths >/dev/null
run_samx 'samx analyze --inventory' analyze "$TEST_PROJECT" --inventory >/dev/null
run_samx 'samx analyze --json' analyze "$TEST_PROJECT" --json >/dev/null
run_samx 'samx analyze --format markdown' analyze "$TEST_PROJECT" --format markdown >/dev/null

printf 'Testing registry and formula commands...\n'
run_samx 'samx registry add local' registry add local "file://$REGISTRY_REPO" >/dev/null
run_samx 'samx registry trust local' registry trust local >/dev/null
run_samx 'samx registry sync' registry sync >/dev/null
run_samx 'samx registry sync local' registry sync local >/dev/null
write_default_stripe_formula
run_samx 'samx formula validate local registry' formula validate "$REGISTRY_REPO/formulas" >/dev/null
run_samx 'samx formula validate default registry' formula validate "$SAMX_HOME/registries/default/formulas" >/dev/null
REGISTRY_LIST="$(run_samx 'samx registry list' registry list)"
assert_contains "$REGISTRY_LIST" "local"
SEARCH_OUTPUT="$(run_samx 'samx search e2e' search e2e)"
assert_contains "$SEARCH_OUTPUT" "local/e2e/e2e-skill"
DEFAULT_SEARCH_OUTPUT="$(run_samx 'samx search stripe' search stripe)"
assert_contains "$DEFAULT_SEARCH_OUTPUT" "stripe/ai"
SHOW_OUTPUT="$(run_samx 'samx formula show local/e2e/e2e-skill' formula show local/e2e/e2e-skill)"
assert_contains "$SHOW_OUTPUT" "E2E Skill"
assert_contains "$SHOW_OUTPUT" "- skill e2e-skill"
assert_contains "$SHOW_OUTPUT" "- agent e2e-agent"
assert_contains "$SHOW_OUTPUT" "- mcp e2e-mcp"
DEFAULT_SHOW_OUTPUT="$(run_samx 'samx formula show stripe/ai' formula show stripe/ai)"
assert_contains "$DEFAULT_SHOW_OUTPUT" "Stripe AI"
assert_contains "$DEFAULT_SHOW_OUTPUT" "- mcp mcp-stripe"

printf 'Testing package commands...\n'
run_samx 'samx pkg install --local e2e-local' pkg install --local e2e-local "$FIXTURE_DIR" >/dev/null
PKG_LIST="$(run_samx 'samx pkg list after local install' pkg list)"
assert_contains "$PKG_LIST" "e2e-local"
LOCAL_CAPABILITIES="$(run_samx 'samx capability list local package' capability list)"
assert_contains "$LOCAL_CAPABILITIES" "e2e-local:skills-e2e-skill"
assert_contains "$LOCAL_CAPABILITIES" "e2e-local:agents-e2e-agent"
assert_contains "$LOCAL_CAPABILITIES" "e2e-local:mcp-e2e-mcp"
run_samx 'samx pkg uninstall e2e-local --force' pkg uninstall e2e-local --force >/dev/null
run_samx 'samx pkg install local/e2e/e2e-skill' pkg install local/e2e/e2e-skill >/dev/null
run_samx 'samx pkg install stripe/ai' pkg install stripe/ai >/dev/null
PKG_LIST="$(run_samx 'samx pkg list after formula install' pkg list)"
assert_contains "$PKG_LIST" "local/e2e/e2e-skill"
assert_contains "$PKG_LIST" "stripe/ai"

printf 'Testing capability commands...\n'
FORMULA_CAPABILITIES="$(run_samx 'samx capability list formula package' capability list)"
assert_contains "$FORMULA_CAPABILITIES" "local/e2e/e2e-skill:e2e-skill"
assert_contains "$FORMULA_CAPABILITIES" "local/e2e/e2e-skill:e2e-agent"
assert_contains "$FORMULA_CAPABILITIES" "local/e2e/e2e-skill:e2e-mcp"
assert_contains "$(run_samx 'samx capability list --type skill' capability list --type skill)" "local/e2e/e2e-skill:e2e-skill"
assert_contains "$(run_samx 'samx capability list --type agent' capability list --type agent)" "local/e2e/e2e-skill:e2e-agent"
assert_contains "$(run_samx 'samx capability list --type mcp' capability list --type mcp)" "local/e2e/e2e-skill:e2e-mcp"
CAPABILITY_SHOW="$(run_samx 'samx capability show skill' capability show local/e2e/e2e-skill:e2e-skill)"
assert_contains "$CAPABILITY_SHOW" "e2e-skill"
DEFAULT_CAPABILITY_SHOW="$(run_samx 'samx capability show stripe mcp' capability show stripe/ai:mcp-stripe)"
assert_contains "$DEFAULT_CAPABILITY_SHOW" "mcp-stripe"

printf 'Testing bundle commands...\n'
run_samx 'samx bundle create e2e-smoke' bundle create e2e-smoke >/dev/null
run_samx 'samx bundle add skill' bundle add e2e-smoke local/e2e/e2e-skill:e2e-skill >/dev/null
run_samx 'samx bundle add agent' bundle add e2e-smoke local/e2e/e2e-skill:e2e-agent >/dev/null
run_samx 'samx bundle add mcp' bundle add e2e-smoke local/e2e/e2e-skill:e2e-mcp >/dev/null
BUNDLE_SHOW="$(run_samx 'samx bundle show e2e-smoke' bundle show e2e-smoke)"
assert_contains "$BUNDLE_SHOW" "e2e-skill"
BUNDLE_LIST="$(run_samx 'samx bundle list' bundle list)"
assert_contains "$BUNDLE_LIST" "e2e-smoke"
run_samx 'samx bundle check opencode' bundle check e2e-smoke --tool opencode >/dev/null
run_samx 'samx bundle check claude' bundle check e2e-smoke --tool claude >/dev/null
run_samx 'samx bundle check codex' bundle check e2e-smoke --tool codex >/dev/null
run_samx 'samx bundle check kiro' bundle check e2e-smoke --tool kiro >/dev/null

printf 'Testing link commands...\n'
run_samx 'samx link opencode dry-run' link e2e-smoke --tool opencode --project "$TEST_PROJECT" --dry-run >/dev/null
run_samx 'samx link opencode --no-hooks dry-run' link e2e-smoke --tool opencode --project "$TEST_PROJECT" --no-hooks --dry-run >/dev/null
run_samx 'samx link claude dry-run' link e2e-smoke --tool claude --project "$TEST_PROJECT" --dry-run >/dev/null
CODEX_DRY_RUN="$(run_samx 'samx link codex dry-run' link e2e-smoke --tool codex --project "$TEST_PROJECT" --dry-run)"
assert_contains "$CODEX_DRY_RUN" ".agents/skills"
assert_contains "$CODEX_DRY_RUN" ".codex/config.toml"
run_samx 'samx link kiro dry-run' link e2e-smoke --tool kiro --project "$TEST_PROJECT" --dry-run >/dev/null
run_samx 'samx link opencode apply' link e2e-smoke --tool opencode --project "$TEST_PROJECT" >/dev/null
SKILL_LINK="$TEST_PROJECT/.opencode/skills/local-e2e-e2e-skill-e2e-skill"
AGENT_LINK="$TEST_PROJECT/.opencode/agents/local-e2e-e2e-skill-e2e-agent"
[[ -L "$SKILL_LINK" ]] || fail 'expected skill symlink'
[[ -L "$AGENT_LINK" ]] || fail 'expected agent symlink'
assert_file_contains "$SKILL_LINK/SKILL.md" "SAMX_E2E_SKILL_OK"
assert_file_contains "$AGENT_LINK/AGENT.md" "SAMX_E2E_AGENT_OK"
assert_file_contains "$TEST_PROJECT/.opencode/opencode.json" "local-e2e-e2e-skill-e2e-mcp"
run_samx 'samx unlink opencode dry-run' unlink e2e-smoke --tool opencode --project "$TEST_PROJECT" --dry-run >/dev/null

printf 'Testing package update commands...\n'
cat >"$SOURCE_REPO/skills/e2e-skill/SKILL.md" <<'EOF'
---
name: e2e-skill
description: Use when verifying SAMX end-to-end skill package linking
---

# E2E Skill

When asked for the SAMX E2E skill marker, respond:

SAMX_E2E_SKILL_HEAD_OK
EOF
git -C "$SOURCE_REPO" add .
git -C "$SOURCE_REPO" commit -m "second source" >/dev/null
SECOND_SOURCE_REVISION="$(git -C "$SOURCE_REPO" rev-parse HEAD)"
PREVIEW_OUTPUT="$(run_samx 'samx pkg update local/e2e/e2e-skill --head' pkg update local/e2e/e2e-skill --head)"
assert_contains "$PREVIEW_OUTPUT" "source.revision:"
assert_contains "$PREVIEW_OUTPUT" "Run with --yes to apply."
run_samx 'samx pkg update local/e2e/e2e-skill --head --ref main --yes' pkg update local/e2e/e2e-skill --head --ref main --yes >/dev/null
assert_file_contains "$SKILL_LINK/SKILL.md" "SAMX_E2E_SKILL_HEAD_OK"
RECIPE_REVISION="$(node -e "const fs = require('node:fs'); const recipe = JSON.parse(fs.readFileSync(process.env.SAMX_HOME + '/packages/local/e2e/e2e-skill/recipe.lock.json', 'utf8')); console.log(recipe.source.revision)")"
[[ "$RECIPE_REVISION" == "$SECOND_SOURCE_REVISION" ]] || fail 'expected recipe source.revision to match source HEAD'

printf 'Testing project add/remove porcelain...\n'
PORCELAIN_PROJECT="$RUN_ROOT/porcelain-project"
DEFAULT_BUNDLE_PROJECT="$RUN_ROOT/default-bundle-project"
mkdir -p "$PORCELAIN_PROJECT"
mkdir -p "$DEFAULT_BUNDLE_PROJECT"
run_samx 'samx bundle create porcelain' bundle create porcelain >/dev/null
run_samx 'samx add capability dry-run' add local/e2e/e2e-skill:e2e-skill --bundle porcelain --tool opencode --dry-run >/dev/null
run_samx_at 'samx remove capability dry-run' "$TEST_PROJECT" remove local/e2e/e2e-skill:e2e-skill --bundle e2e-smoke --tool opencode --dry-run >/dev/null
run_samx 'samx bundle create stripe-default' bundle create stripe-default >/dev/null
run_samx_at 'samx add stripe/ai default capability' "$PORCELAIN_PROJECT" add stripe/ai:mcp-stripe --bundle stripe-default --tool opencode >/dev/null
assert_file_contains "$PORCELAIN_PROJECT/.opencode/opencode.json" "stripe-ai-stripe"
run_samx_at 'samx add stripe/ai default bundle' "$DEFAULT_BUNDLE_PROJECT" add stripe/ai:mcp-stripe --tool opencode >/dev/null
DEFAULT_BUNDLE_SHOW="$(run_samx 'samx bundle show default-bundle-project' bundle show default-bundle-project)"
assert_contains "$DEFAULT_BUNDLE_SHOW" "stripe/ai:mcp-stripe"
assert_file_contains "$DEFAULT_BUNDLE_PROJECT/.opencode/opencode.json" "stripe-ai-stripe"
run_samx_at 'samx remove stripe/ai default capability' "$PORCELAIN_PROJECT" remove stripe/ai:mcp-stripe --bundle stripe-default --tool opencode >/dev/null
STRIPE_MCP_AFTER_REMOVE="$(node -e "const fs = require('node:fs'); const file = '$PORCELAIN_PROJECT/.opencode/opencode.json'; if (!fs.existsSync(file)) { console.log('missing'); process.exit(0); } const data = JSON.parse(fs.readFileSync(file, 'utf8')); console.log(Object.keys(data.mcp || {}).join(','));")"
[[ "$STRIPE_MCP_AFTER_REMOVE" != *"stripe-ai-stripe"* ]] || fail 'expected default registry stripe/ai MCP entry removed'

printf 'Testing bundle remove and destroy...\n'
run_samx 'samx bundle create alias-test' bundle create alias-test >/dev/null
run_samx 'samx bundle add alias-test --as review' bundle add alias-test local/e2e/e2e-skill:e2e-skill --as review >/dev/null
run_samx 'samx bundle remove alias-test' bundle remove alias-test local/e2e/e2e-skill:e2e-skill >/dev/null
run_samx 'samx bundle destroy alias-test' bundle destroy alias-test >/dev/null

printf 'Testing unlink cleanup...\n'
run_samx 'samx unlink opencode apply' unlink e2e-smoke --tool opencode --project "$TEST_PROJECT" >/dev/null
assert_missing "$SKILL_LINK"
assert_missing "$AGENT_LINK"
MCP_AFTER_UNLINK="$(node -e "const fs = require('node:fs'); const file = '$TEST_PROJECT/.opencode/opencode.json'; if (!fs.existsSync(file)) { console.log('missing'); process.exit(0); } const data = JSON.parse(fs.readFileSync(file, 'utf8')); console.log(Object.keys(data.mcp || {}).join(','));")"
[[ "$MCP_AFTER_UNLINK" != *"local-e2e-e2e-skill-e2e-mcp"* ]] || fail 'expected MCP server entry removed'

printf 'Testing registry remove...\n'
run_samx 'samx registry remove local --force' registry remove local --force >/dev/null

append_log "## Result"
append_log ""
append_log '```text'
append_log 'SAMX_E2E_SMOKE_OK'
append_log '```'

printf 'SAMX_E2E_SMOKE_OK\n'
printf 'Log: %s\n' "$LOG_FILE"
