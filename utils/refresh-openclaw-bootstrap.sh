#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${OPENCLAW_CONTAINER_NAME:-openclaw-pma3-openclaw-1}"
HEALTH_TIMEOUT_SECONDS="${OPENCLAW_HEALTH_TIMEOUT_SECONDS:-60}"

echo "Restarting ${CONTAINER_NAME}..."
docker restart "${CONTAINER_NAME}" >/dev/null

echo "Waiting for OpenClaw health..."
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  if openclaw health >/tmp/openclaw-health.out 2>/tmp/openclaw-health.err; then
    cat /tmp/openclaw-health.out
    echo
    echo "Bootstrap cache cleared. The next agent turn will reload workspace bootstrap files."
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for OpenClaw health." >&2
if [[ -s /tmp/openclaw-health.err ]]; then
  cat /tmp/openclaw-health.err >&2
fi
exit 1
