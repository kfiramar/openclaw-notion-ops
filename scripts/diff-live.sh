#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="${OPENCLAW_WORKSPACE:-/docker/openclaw-pma3/data/.openclaw/workspace-personal}"
OPENCLAW_HOST_ROOT="$(dirname "$WORKSPACE_ROOT")"
MIRROR_SYNC_HOST="${NOTION_MIRROR_SYNC_HOST:-$OPENCLAW_HOST_ROOT/skills/notion-local-mirror/scripts/notion-sync.mjs}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TMP_DIR="$TMP_DIR" node --input-type=module <<'EOF'
import fs from "node:fs";
import path from "node:path";
import { syncOpenClaw, ensureDir, liveConfigText, liveEntrypointText } from "/root/openclaw-notion-ops/scripts/sync-to-openclaw.mjs";

const tmpDir = process.env.TMP_DIR;
const repoRoot = "/root/openclaw-notion-ops";

ensureDir(path.join(tmpDir, "lifestyle-ops-lib"));
for (const file of fs.readdirSync(path.join(repoRoot, "src"))) {
  if (!file.endsWith(".mjs") || file === "config.mjs") continue;
  fs.copyFileSync(
    path.join(repoRoot, "src", file),
    path.join(tmpDir, "lifestyle-ops-lib", file)
  );
}
fs.writeFileSync(path.join(tmpDir, "lifestyle-ops-lib", "config.mjs"), liveConfigText());
fs.writeFileSync(path.join(tmpDir, "lifestyle-ops.mjs"), liveEntrypointText());
ensureDir(path.join(tmpDir, "skills", "notion-local-mirror", "scripts"));
fs.copyFileSync(
  path.join(repoRoot, "scripts", "notion-local-mirror-sync.mjs"),
  path.join(tmpDir, "skills", "notion-local-mirror", "scripts", "notion-sync.mjs")
);
await syncOpenClaw({ check: true });
EOF

diff -ru \
  "$TMP_DIR/lifestyle-ops-lib" \
  "$WORKSPACE_ROOT/lifestyle-ops-lib" || true

diff -u \
  "$TMP_DIR/lifestyle-ops.mjs" \
  "$WORKSPACE_ROOT/lifestyle-ops.mjs" || true

diff -u \
  "$TMP_DIR/skills/notion-local-mirror/scripts/notion-sync.mjs" \
  "$MIRROR_SYNC_HOST" || true
