#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="${OPENCLAW_WORKSPACE:-/docker/openclaw-pma3/data/.openclaw/workspace-personal}"

diff -ru \
  "$REPO_ROOT/src" \
  "$WORKSPACE_ROOT/lifestyle-ops-lib" || true

diff -u \
  "$REPO_ROOT/notion-board-ops.mjs" \
  "$WORKSPACE_ROOT/lifestyle-ops.mjs" || true
