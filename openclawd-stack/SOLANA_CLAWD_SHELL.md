# Solana Clawd Runtime Shell - Integration Guide

> Integration of NVIDIA OpenShell, nemoClawd, solana-clawd, and agentic wallet for a unified Solana AI agent runtime

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        SOLANA CLAWD RUNTIME SHELL                          │
├─────────────────────────────────────────────────────────────────────────────┤
│  OpenShell Sandbox (NVIDIA)                                                 │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Sandboxed Execution Environment                                     │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐  │   │
│  │  │   Privy     │  │  nemoClawd │  │   solana-clawd runtime     │  │   │
│  │  │  Wallet     │  │   CLI      │  │   + MCP Server             │  │   │
│  │  │  Auth       │  │  + xAI     │  │   + OODA Trading Engine   │  │   │
│  │  └──────┬──────┘  └──────┬──────┘  └──────────────┬────────────┘  │   │
│  │         │                 │                          │               │   │
│  │         └────────┬────────┴──────────────────────────┘               │   │
│  │                  │                                                       │   │
│  │           ┌──────▼──────┐                                               │   │
│  │           │ agentwallet │                                               │   │
│  │           │   -vault    │  Encrypted wallet management                  │   │
│  │           │  AES-256    │  Secure key storage                          │   │
│  │           └─────────────┘                                               │   │
│  │                                                                       │   │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │   │
│  │  │  MCP Tools (31)                                                │  │   │
│  │  │  - solana_price, solana_trending, solana_wallet_pnl           │  │   │
│  │  │  - helius_account_info, helius_balance, helius_transactions   │  │   │
│  │  │  - pump_token_scan, pump_buy_quote, pump_sell_quote           │  │   │
│  │  │  - memory_recall, memory_write                                │  │   │
│  │  │  - agent_spawn, agent_list, agent_stop                        │  │   │
│  │  └─────────────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  OpenShell Policy Engine (OPA/Rego)                                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Network Policy: Allow Solana RPC, Helius, Jupiter, Pump.fun        │   │
│  │  Filesystem Policy: ~/.clawd/, ~/.nemoclaw/                        │   │
│  │  Process Policy: Allow solana-clawd, nemoclaw, npm, node           │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Option 1: OpenShell Sandbox

```bash
# Create Solana Clawd sandbox (once community image is published)
openshell sandbox create --from solana-clawd -- solana-clawd-start

# Or manually
openshell sandbox create --from solana-clawd
openshell sandbox connect solana-clawd
```

### Option 2: Direct Installation

```bash
# Install solana-clawd
npm i -g solana-clawd

# Install nemoClawd
npm install -g @mawdbotsonsolana/nemoclaw

# Initialize wallet
agentwallet serve --port 9099
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HELIUS_API_KEY` | Yes | Helius RPC/DAS API key (free at helius.dev) |
| `HELIUS_RPC_URL` | Yes | Helius mainnet RPC endpoint |
| `XAI_API_KEY` | Yes | xAI API key for Grok integration |
| `SOLANA_PRIVATE_KEY` | Optional | Base58 private key for trading |
| `PRIVY_APP_ID` | Optional | Privy app ID for wallet auth |
| `OPENROUTER_API_KEY` | Optional | OpenRouter for multi-model routing |

## Provider Configuration

### OpenShell Provider (solana-clawd)

```bash
# Create provider with auto-discovery
openshell provider create --type solana-clawd --name solana-clawd --from-existing

# Manual provider creation
openshell provider create --type solana-clawd --name solana-clawd \
  --credential HELIUS_API_KEY \
  --credential XAI_API_KEY \
  --credential SOLANA_PRIVATE_KEY
```

### Provider Discovery

The solana-clawd provider plugin discovers:
- `HELIUS_API_KEY`, `HELIUS_RPC_URL`
- `XAI_API_KEY`
- `OPENAI_API_KEY`, `OPENROUTER_API_KEY`
- `SOLANA_PRIVATE_KEY`
- Config paths: `~/.clawd/*.json`, `~/.nemoclaw/*.json`

## MCP Tools

### Solana Market Data
- `solana_price` - Token price lookup
- `solana_trending` - Trending tokens
- `solana_token_info` - Token metadata
- `solana_wallet_pnl` - Wallet P&L analysis

### Helius Onchain
- `helius_account_info` - Account data
- `helius_balance` - SOL balance
- `helius_transactions` - Transaction history
- `helius_priority_fee` - Priority fee estimation
- `helius_das_asset` - DAS asset lookup

### Trading (Pump.fun)
- `pump_token_scan` - Scan new tokens
- `pump_buy_quote` - Get buy quote
- `pump_sell_quote` - Get sell quote
- `pump_graduation` - Check graduation status

### Memory
- `memory_recall` - Query memory tiers
- `memory_write` - Write to memory

### Agent Fleet
- `agent_spawn` - Spawn new agent
- `agent_list` - List running agents
- `agent_stop` - Stop agent

## Agentic Wallet Integration

### Privy Integration

```typescript
import { PrivyWalletProvider } from '@privy-io/react-auth';

// Wallet authentication
const wallet = await PrivyWalletProvider.create({
  appId: process.env.PRIVY_APP_ID,
  solana: {
    adapter: phantomAdapter(),
  },
});

// Sign transaction
const signature = await wallet.signTransaction(transaction);
```

### agentwallet-vault

```bash
# Start vault server
agentwallet serve --port 9099

# Create encrypted wallet
agentwallet wallet create trading-wallet --chain solana

# List wallets
agentwallet wallet list

# Export vault (encrypted)
agentwallet vault export > backup.json
```

## OODA Trading Loop

```
OBSERVE  → sol_price, trending, helius_priority_fee, memory KNOWN
ORIENT   → score candidates (trend + momentum + liquidity)
DECIDE   → confidence ≥ 60? → size band (0.5x / 1.0x / 1.25x / 1.5x)
ACT      → trade_execute gated at `ask` permission (human approval required)
LEARN    → write INFERRED signals → Dream agent promotes to LEARNED
```

## Policy YAML

### Network Policy (network-policy.yaml)

```yaml
inbound:
  allow:
    - from: localhost

outbound:
  allow:
    - host: "api.mainnet.helius-rpc.com"
      port: 443
      protocol: https
    - host: "rpc.helius.xyz"
      port: 443
      protocol: https
    - host: "api.coingecko.com"
      port: 443
      protocol: https
    - host: "pump.fun"
      port: 443
      protocol: https
    - host: "api.x.ai"
      port: 443
      protocol: https
    - host: "openrouter.ai"
      port: 443
      protocol: https
```

### Filesystem Policy

```yaml
filesystem:
  allow:
    - path: ~/.clawd
      permissions: [read, write]
    - path: ~/.nemoclaw
      permissions: [read, write]
    - path: ~/.config/clawd
      permissions: [read, write]
  deny:
    - path: ~/
      permissions: [write]
```

## Deployment

### Fly.io

```bash
cd MCP
fly launch --config fly.toml
fly secrets set HELIUS_API_KEY=xxx XAI_API_KEY=xxx
```

### E2B Sandbox

```bash
agentwallet deploy e2b --api-key $E2B_API_KEY
```

## Security

1. **Sandbox Isolation**: All agent operations run in OpenShell sandbox
2. **Encrypted Wallets**: AES-256-GCM encryption via agentwallet-vault
3. **Policy Enforcement**: OPA/Rego policies control network/filesystem access
4. **Permission Engine**: Default `ask` mode requires human approval for trades
5. **Credential Injection**: Provider secrets resolved at proxy time, never in process env

## Next Steps

- [ ] Create OpenShell community sandbox manifest
- [ ] Implement solana-clawd provider plugin
- [ ] Add Privy wallet adapter
- [ ] Test MCP tool connectivity
- [ ] Verify policy enforcement
