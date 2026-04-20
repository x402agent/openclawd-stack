# E2B sandbox template image for the Solana Clawd gateway.
# Baked by `pnpm build` → `e2b template build` in the sibling e2b.toml.
FROM e2bdev/code-interpreter:latest

# ── System deps ────────────────────────────────────────────────────────────
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl git ca-certificates build-essential pkg-config libssl-dev jq iproute2 \
 && rm -rf /var/lib/apt/lists/*

# ── Go toolchain (for building the clawd Go binary when a Go entrypoint exists) ─
RUN curl -fsSL https://go.dev/dl/go1.23.2.linux-amd64.tar.gz -o /tmp/go.tgz \
 && tar -C /usr/local -xzf /tmp/go.tgz \
 && rm /tmp/go.tgz \
 && echo 'export PATH=$PATH:/usr/local/go/bin:/root/go/bin' >> /etc/profile \
 && ln -sf /usr/local/go/bin/go /usr/local/bin/go

# ── Solana CLI (optional; pin to a known-good Agave release) ──────────────
# anza's "stable" installer requires an explicit tag, so we pin here.
# Bump when a newer release is needed.
RUN sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.5/install)" -- --no-modify-path || true

# ── Node globals used by the sandboxed CLI + agent flows ───────────────────
RUN npm install -g \
      solana-clawd \
      @solana/web3.js \
      @metaplex-foundation/umi \
      @metaplex-foundation/umi-bundle-defaults \
      @metaplex-foundation/mpl-core \
      ws hono @hono/node-server jose pino zod

# ── Clone + build the Go runtime and clawdrouter (best-effort) ─────────────
# clawdrouter's package.json is nested inside a `clawdrouter/` subdir at the
# repo root — detect whichever directory has one and install there.
RUN mkdir -p /opt/clawd \
 && git clone --depth 1 https://github.com/x402agent/solana-clawd /opt/clawd/solana-clawd \
 && (cd /opt/clawd/solana-clawd \
     && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
        -o /usr/local/bin/clawd-runtime ./cmd/clawd || echo "(skipping Go build if entrypoint absent)") \
 && git clone --depth 1 https://github.com/x402agent/clawdrouter /opt/clawd/clawdrouter \
 && ROUTER_DIR=$(find /opt/clawd/clawdrouter -maxdepth 3 -name package.json -not -path '*/node_modules/*' | head -1 | xargs -r dirname) \
 && if [ -n "$ROUTER_DIR" ]; then \
      echo "[clawdrouter] installing in $ROUTER_DIR" \
      && (cd "$ROUTER_DIR" && npm install --omit=dev && npm run build || true); \
    else \
      echo "[clawdrouter] no package.json found — skipping"; \
    fi

# ── Bake default config + entrypoint + our gateway bundle ──────────────────
COPY ./config/clawd.default.yml /etc/clawd/config.yml
COPY ./entrypoint.sh /usr/local/bin/clawd-entrypoint
# Gateway is staged into .build/gateway by build.ts (Docker can't COPY ..)
COPY ./.build/gateway /opt/clawd/gateway

RUN chmod +x /usr/local/bin/clawd-entrypoint \
 # Build the gateway: install all deps (incl tsc), compile, prune to prod.
 && cd /opt/clawd/gateway \
 && npm install \
 && npm run build \
 && npm prune --production \
 # /workspace — user project files (vibe-coding projects, etc.)
 && mkdir -p /workspace && chmod 0777 /workspace \
 # /vault — the Clawd vault (tiered memory). World-writable so the
 # sandbox's non-root runtime user can append tier JSONLs.
 && mkdir -p /vault && chmod 0777 /vault \
 && touch /vault/known.jsonl /vault/learned.jsonl /vault/inferred.jsonl \
 && chmod 0666 /vault/known.jsonl /vault/learned.jsonl /vault/inferred.jsonl \
 # /var/lib/clawd — runtime state (Honcho offsets, resume snapshot).
 # Orchestrator drops files here via SDK (root-equivalent), entrypoint
 # reads them as the runtime user — world-writable is fine.
 && mkdir -p /var/lib/clawd && chmod 0777 /var/lib/clawd
