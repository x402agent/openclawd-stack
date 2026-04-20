# E2B Solana Clawd Template

> Deploy Solana Clawd Runtime to E2B cloud sandboxes for secure remote agent access

## Overview

This template provides a ready-to-deploy E2B sandbox with:
- Solana Clawd Runtime (solana-clawd + nemoClawd)
- 31 MCP Tools for Solana trading and research
- xAI Grok integration
- Agentic wallet support (Privy)
- Helius RPC connectivity

## Quick Start

### Prerequisites
- E2B API key (`E2B_API_KEY`)
- Helius API key (`HELIUS_API_KEY`)
- Optional: xAI API key (`XAI_API_KEY`)

### Deploy with SDK

```typescript
import { E2B } from '@e2b/sdk';

const e2b = new E2B({ apiKey: process.env.E2B_API_KEY! });

// Create sandbox from template
const sandbox = await e2b.sandbox.create({
  template: 'solana-clawd',
  metadata: {
    agentId: 'my-trading-agent',
  },
  onStart: async (sandbox) => {
    // Run initialization commands
    await sandbox.notebook.exec('clawd init --non-interactive');
    
    // Start MCP server
    await sandbox.notebook.exec('solana-clawd-mcp &');
  },
});

// Access sandbox
console.log('Sandbox ID:', sandbox.id);
console.log('Status:', sandbox.status);

// Execute commands
const result = await sandbox.notebook.exec('helius_balance --address <wallet>');
console.log(result);

await sandbox.kill();
```

### Deploy via CLI

```bash
# Build and deploy template
e2b template build ./e2b-solana-clawd

# Create sandbox from template
e2b sandbox create --template solana-clawd
```

## Template Files

### `e2b.toml`

```toml
[template]
name = "solana-clawd"
runtime = "ubuntu24.04"

[start]
cmd = "bash /startup.sh"
timeout = 120

[maintenance]
autoDestroy = true
```

### `startup.sh`

```bash
#!/bin/bash
set -e

echo "=== Solana Clawd Runtime E2B Sandbox ==="
echo "Initializing..."

# Set environment
export HELIUS_API_KEY="${HELIUS_API_KEY}"
export HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY"
export XAI_API_KEY="${XAI_API_KEY}"
export PATH="/root/.local/bin:$PATH"

# Initialize clawd
if [ ! -f ~/.clawd/configured ]; then
    echo "Initializing solana-clawd..."
    clawd init --non-interactive || true
    touch ~/.clawd/configured
fi

# Start MCP server in background
echo "Starting MCP server..."
solana-clawd-mcp &
MCP_PID=$!

echo "=== Sandbox Ready ==="
echo "MCP Server PID: $MCP_PID"
echo "Run 'help' for available commands"

# Keep container alive
tail -f /dev/null
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HELIUS_API_KEY` | Yes | Helius RPC/DAS API key |
| `HELIUS_RPC_URL` | Auto | Set automatically from API key |
| `XAI_API_KEY` | Optional | xAI Grok API key |
| `SOLANA_PRIVATE_KEY` | Optional | Trading wallet private key |
| `PRIVY_APP_ID` | Optional | Privy wallet app ID |

## Available Commands

```bash
# CLI commands
clawd go              # Start solana-clawd agent
nemoclaw launch      # Start nemoClawd
nemoclaw demo        # Run demo walkthrough

# MCP tools
helius_balance --address <wallet>
helius_transactions --address <wallet>
pump_token_scan
pump_buy_quote --mint <token> --amount 0.1

# Wallet
agentwallet wallet list
agentwallet serve --port 9099
```

## Security

- All operations run in isolated E2B sandbox
- No persistent storage between sessions (unless using mounted volume)
- Environment variables injected at runtime
- Network access controlled by E2B firewall

## Pricing

- E2B sandbox pricing: $0.00005/second (sandbox) + compute
- Recommended: Use auto-destroy for cost efficiency
- Estimate: ~$0.18/hour for active trading

## Next Steps

1. Set up E2B API key at https://e2b.dev
2. Build template: `e2b template build ./e2b-solana-clawd`
3. Create sandbox and connect via SDK
4. Integrate with Claude Code or other agents
