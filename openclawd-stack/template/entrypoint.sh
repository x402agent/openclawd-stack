#!/usr/bin/env bash
# /usr/local/bin/clawd-entrypoint
#
# Runs inside the E2B sandbox. Structured as a supervisor loop so the
# orchestrator can rotate secrets without killing the sandbox:
#
#   1. Orchestrator writes /var/lib/clawd/envs.sh with `export FOO=...`.
#   2. Orchestrator kills the node child: `pkill -f server.js`.
#   3. This loop catches SIGCHLD, re-sources envs.sh, respawns the gateway
#      with the new environment.
#
# The outer bash process (start_cmd) NEVER exits, so the sandbox stays alive.
# Only the child node process is restarted.

# NOTE: deliberately no `-e` — we want the loop to continue past child exits.
set -uo pipefail

export PATH="$PATH:/usr/local/go/bin:/root/.local/share/solana/install/active_release/bin"

PORT="${CLAWD_GATEWAY_PORT:-18789}"
WORKSPACE="${CLAWD_WORKSPACE:-/workspace}"
VAULT_DIR="${CLAWD_VAULT_DIR:-/vault}"
ENVS_FILE="/var/lib/clawd/envs.sh"

mkdir -p "$WORKSPACE" "$VAULT_DIR" /var/lib/clawd 2>/dev/null || true
touch "$VAULT_DIR/known.jsonl" "$VAULT_DIR/learned.jsonl" "$VAULT_DIR/inferred.jsonl" 2>/dev/null || true

# One-shot hydration of the Clawd vault from an orchestrator-uploaded snapshot.
if [[ -f /var/lib/clawd/honcho-snapshot.json ]]; then
  echo "[entrypoint] rehydrating Clawd vault from snapshot"
  node /opt/clawd/gateway/scripts/rehydrate.js /var/lib/clawd/honcho-snapshot.json || true
fi

cd /opt/clawd/gateway

while true; do
  # Reload rotatable envs (OPENAI_API_KEY, CLAWD_GATEWAY_TOKEN, etc.).
  # Orchestrator writes this via sbx.files.write after Sandbox.create.
  if [[ -f "$ENVS_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$ENVS_FILE"
  fi
  AUTH_MODE="${CLAWD_AUTH_MODE:-both}"

  echo "[entrypoint] starting gateway auth=$AUTH_MODE port=$PORT"
  node /opt/clawd/gateway/dist/server.js \
    --port "$PORT" \
    --auth "$AUTH_MODE" \
    --workspace "$WORKSPACE" \
    --vault "$VAULT_DIR"
  exit_code=$?
  echo "[entrypoint] gateway exited ($exit_code), respawning in 1s"
  sleep 1
done
