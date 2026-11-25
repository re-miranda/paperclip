#!/usr/bin/env bash
# Gambiarra. MIR-2027: build, check and package one exact fork commit on a GitHub Actions runner.
# The packaging functions (server_closure_dirs .. pack_result) are the reviewed U2 logic from
# MIR-1133 attempt 2 build.sh (sha256 1afcafbe...), with paths and the version made inputs.
# Usage: ci.sh <request|prepare|build|typecheck|tests|package|full-tests>
set -euo pipefail

readonly HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
readonly WORK=${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is not set; this script only runs in GitHub Actions}
readonly REQUEST=$HERE/request.json
readonly SRC=$WORK/source STAGE=$WORK/stage RESULT=$WORK/result LOGS=$WORK/logs
readonly STORE_GIT=$WORK/paperclip-home/cli/installs/git

log() { printf '%s ci: %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "FAIL: $*"; exit 1; }
summary() { printf '%s\n' "$*" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"; }

load_request() {
  SHA=$(jq -er '.sha' "$REQUEST") || die "$REQUEST has no string 'sha'"
  LABEL=$(jq -er '.label' "$REQUEST") || die "$REQUEST has no string 'label'"
  VERSION=$(jq -er '.version' "$REQUEST") || die "$REQUEST has no string 'version'"
  mapfile -t TESTS < <(jq -er '.tests[]' "$REQUEST")  # empty list is rejected below
  [[ $SHA =~ ^[0-9a-f]{40}$ ]] || die "request sha '$SHA'; expected 40 lowercase hex digits"
  [[ $LABEL =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "request label '$LABEL'; expected 1-40 of A-Z a-z 0-9 . _ -"
  [[ $VERSION =~ ^[0-9]{4}\.[0-9]{4}\.[0-9]+$ ]] || die "request version '$VERSION'; expected YYYY.MMDD.N"
  [ "${#TESTS[@]}" -gt 0 ] || die "request tests is empty; expected at least one test file"
  local t
  for t in "${TESTS[@]}"; do
    [[ $t =~ ^[A-Za-z0-9._/@-]+\.test\.tsx?$ && $t != *..* && $t != /* ]] \
      || die "request test path '$t'; expected a repo-relative path ending in .test.ts"
  done
  SHORT=${SHA:0:12}
  PAYLOAD=$STORE_GIT/$SHORT
}

setup_env() {
  export COREPACK_HOME=$WORK/corepack PATH=$WORK/pnpm-bin:$PATH
  export PAPERCLIP_BUILD_COMMIT=$SHA PAPERCLIP_README_ASSET_REF=$SHA
  export DO_NOT_TRACK=1 PAPERCLIP_TELEMETRY_ENABLED=false
  unset NODE_ENV GH_TOKEN GITHUB_TOKEN
}

# Isolated test home, as scripts/run-vitest-stable.mjs does (MIR-1133 test:run used the same wrapper).
test_env() {
  local root
  root=$(mktemp -d /tmp/pv-XXXXXX)
  mkdir -p "$root/h" "$root/t"
  export NODE_ENV=test PAPERCLIP_TEST_HOST_HOME=$HOME/.paperclip PAPERCLIP_HOME=$root/h
  export PAPERCLIP_CONFIG=$root/h/config.json PAPERCLIP_INSTANCE_ID=vt-ci TMPDIR=$root/t
}

phase_request() {
  load_request
  { echo "sha=$SHA"; echo "label=$LABEL"; echo "version=$VERSION"; } >> "$GITHUB_OUTPUT"
  summary "## Fork build request" "" "- Commit: \`$SHA\`" "- Label: \`$LABEL\`" "- Version: \`$VERSION\`"
  summary "- Named tests: ${#TESTS[@]}" "$(printf '  - `%s`\n' "${TESTS[@]}")"
}

phase_prepare() {
  local actual toolchain t
  actual=$(git -C "$SRC" rev-parse HEAD)
  [ "$actual" = "$SHA" ] || die "checked-out HEAD is '$actual'; expected '$SHA'"
  for t in "${TESTS[@]}"; do [ -f "$SRC/$t" ] || die "named test file '$t' does not exist at $SHA"; done
  # codeload layout: every entry under paperclip-<sha>/ (what the owner's install steps unpack).
  git -C "$SRC" archive --format=tar.gz --prefix="paperclip-$SHA/" -o "$WORK/source.tar.gz" "$SHA"
  toolchain=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$SRC/packages/paperclip-runner/rust-toolchain.toml")
  [ -n "$toolchain" ] || die "no rust channel in packages/paperclip-runner/rust-toolchain.toml at $SHA"
  log "Rust $toolchain, then pnpm install --frozen-lockfile for $SHA"
  rustup toolchain install "$toolchain" --profile minimal --component rustfmt
  mkdir -p "$WORK/pnpm-bin"
  (cd "$SRC" && corepack enable pnpm --install-directory "$WORK/pnpm-bin" && corepack pnpm install --frozen-lockfile)
}

release_step2_build() {
  log "release step 2/7: workspace build, UI dist, skills"
  cd "$SRC"
  pnpm build
  node scripts/build-standalone-public-packages.mjs
  bash scripts/prepare-server-ui-dist.sh
  local pkg
  for pkg in server packages/adapters/claude-local packages/adapters/codex-local; do
    rm -rf "$SRC/$pkg/skills"
    cp -r "$SRC/skills" "$SRC/$pkg/skills"
  done
}

release_steps3_4() {
  cd "$SRC"
  log "release step 3/7 set-version $VERSION"
  node scripts/release-package-map.mjs set-version "$VERSION"
  log "release step 4/7 build-npm.sh"
  bash scripts/build-npm.sh --skip-checks --skip-typecheck
  local cli_version
  cli_version=$(node -p "require('./cli/package.json').version")
  [ "$cli_version" = "$VERSION" ] || die "cli/package.json version '$cli_version'; expected $VERSION"
  # installGitPayload() rebuilds the server closure after build-npm.sh; keep that order.
  PAPERCLIP_RELEASE_REUSE_UI_DIST=1 corepack pnpm -r --filter '@paperclipai/server...' --if-present run build
}

server_closure_dirs() {
  # Same walk as installGitPayload()'s resolveGitInstallWorkspacePackages(); prints dirs in dependency order.
  node --input-type=module -e '
    import fs from "node:fs"; import path from "node:path";
    const root = process.argv[1];
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "scripts/release-package-manifest.json"), "utf8"));
    const byName = new Map(manifest.map((e) => [e.name, e]));
    const done = new Set(); const out = [];
    const visit = (name) => {
      if (done.has(name)) return;
      const entry = byName.get(name);
      if (!entry) throw new Error(`workspace package ${name} missing from release-package-manifest.json`);
      done.add(name);
      const pkg = JSON.parse(fs.readFileSync(path.join(root, entry.dir, "package.json"), "utf8"));
      for (const s of ["dependencies", "optionalDependencies", "peerDependencies"])
        for (const dep of Object.keys(pkg[s] ?? {})) if (dep.startsWith("@paperclipai/")) visit(dep);
      out.push(entry.dir);
    };
    visit("@paperclipai/server");
    console.log(out.join("\n"));
  ' "$SRC"
}

is_bundled_package() {
  node -e 'const p=require(process.argv[1]); process.exit((p.bundleDependencies ?? p.bundledDependencies ?? []).length > 0 ? 0 : 1)' "$1/package.json"
}

pack_workspace_package() {
  local dir=$1 index=$2
  if is_bundled_package "$SRC/$dir"; then
    local staged=$STAGE/workspace-package-$index
    node "$SRC/scripts/prepare-bundled-package.mjs" "$SRC/$dir" "$staged"
    # Release packs bundled packages with scripts off; the server prepack would rebuild otherwise.
    npm pack "$staged" --pack-destination "$STAGE" --ignore-scripts
    return
  fi
  PAPERCLIP_RELEASE_REUSE_UI_DIST=1 corepack pnpm --dir "$SRC/$dir" pack --pack-destination "$STAGE"
}

pack_all() {
  log "pack server closure and CLI"
  cd "$SRC"
  local dirs index=0 dir
  dirs=$(server_closure_dirs)
  for dir in $dirs; do
    pack_workspace_package "$dir" "$index"
    index=$((index + 1))
  done
  (cd "$SRC/cli" && npm pack --pack-destination "$STAGE")
  local workspace_count
  workspace_count=$(find "$STAGE" -maxdepth 1 -name '*.tgz' ! -name "paperclipai-$VERSION.tgz" | wc -l)
  [ -f "$STAGE/paperclipai-$VERSION.tgz" ] || die "missing $STAGE/paperclipai-$VERSION.tgz"
  [ "$workspace_count" -eq "$index" ] || die "$workspace_count workspace tarballs; expected $index"
}

install_payload() {
  log "npm install payload and place it at $PAYLOAD"
  local staged=$STAGE/payload smoke
  (cd "$STAGE" && npm install --prefix "$staged" "$STAGE"/*.tgz --no-audit --no-fund)
  smoke=$(node "$staged/node_modules/paperclipai/dist/index.js" --version | awk '{print $1}')
  [ "$smoke" = "$VERSION" ] || die "payload CLI reports '$smoke'; expected $VERSION"
  mkdir -p -m 700 "$STORE_GIT"
  mv "$staged" "$PAYLOAD"
}

pack_result() {
  log "pack payload and source archive"
  mkdir -p "$RESULT"
  tar -C "$STORE_GIT" -czf "$RESULT/payload.tar.gz" "$SHORT"
  cp "$WORK/source.tar.gz" "$RESULT/source.tar.gz"
  (cd "$RESULT" && sha256sum payload.tar.gz source.tar.gz > SHA256SUMS)
  cat "$RESULT/SHA256SUMS"
  # MIR-2027: the commit is stated inside the artifact, outside SHA256SUMS so `sha256sum -c` is unchanged.
  { echo "commit=$SHA"; echo "version=$VERSION"; echo "label=$LABEL"; echo "tests=${TESTS[*]}"
    echo "runner_image=${ImageVersion:-unknown}"; echo "built_at=$(date -u +%FT%TZ)"; } > "$RESULT/BUILD-INFO.txt"
  summary "## Package" "" "Commit \`$SHA\`, version \`$VERSION\`" '```' "$(cat "$RESULT/SHA256SUMS")" '```'
}

phase_package() {
  [ -f "$LOGS/typecheck.ok" ] && [ -f "$LOGS/tests.ok" ] || die "typecheck.ok or tests.ok is missing in $LOGS; checks must pass before packaging"
  release_steps3_4; pack_all; install_payload; pack_result
}

# Runs one phase; the *.ok marker is only written when the command succeeds.
run_phase() {
  local phase=$1
  case "$phase" in
    request) phase_request ;;
    prepare) phase_prepare ;;
    build) release_step2_build ;;
    typecheck) cd "$SRC" && corepack pnpm --filter @paperclipai/server typecheck && touch "$LOGS/typecheck.ok" ;;
    tests) test_env; cd "$SRC" && corepack pnpm exec vitest run "${TESTS[@]}" && touch "$LOGS/tests.ok" ;;
    package) phase_package ;;
    full-tests) cd "$SRC" && corepack pnpm test:run ;;
    *) die "phase '$phase'; expected request, prepare, build, typecheck, tests, package or full-tests" ;;
  esac
}

readonly PHASE=${1:-missing}
mkdir -p "$LOGS"
load_request
setup_env
log "phase $PHASE, commit $SHA, label $LABEL"
run_phase "$PHASE" 2>&1 | tee -a "$LOGS/$PHASE.log"
