# OpenClawd Stack

> Integrated Solana AI agent runtime combining OpenShell, nemoClawd, solana-clawd, and agentic wallets

## Overview

This stack provides a complete Solana AI agent runtime with:
- **OpenShell Sandboxes** - Secure, isolated execution environments (NVIDIA)
- **nemoClawd** - xAI Grok integration with 31 MCP tools
- **solana-clawd** - OODA trading engine and Solana-native operations
- **Agentic Wallets** - Privy + agentwallet-vault for secure key management
- **E2B Deployment** - Cloud sandbox deployment ready

## Quick Start

### 1. Local Development

```bash
# Install solana-clawd CLI
npm i -g solana-clawd

# Start solana-clawd runtime
clawd go
```

### 2. OpenShell Sandbox

```bash
# Create sandbox
openshell sandbox create --from solana-clawd -- solana-clawd

# Connect to sandbox
openshell sandbox connect solana-clawd
```

### 3. E2B Cloud Deployment

```bash
# Deploy to E2B
cd deploy/e2b-solana-clawd
pnpm install
E2B_API_KEY=xxx HELIUS_API_KEY=xxx pnpm deploy
```

## Project Structure

```
openclawd-stack/
├── OpenShell-community/
│   └── solana-clawd/          # OpenShell community sandbox
│       ├── Dockerfile
│       └── sandbox.toml
├── orchestrator/
│   ├── solana-clawd-mcp/      # MCP server (31 tools)
│   │   └── src/index.ts
│   └── privy-agentic-wallet/   # Privy wallet integration
│       └── src/index.ts
├── deploy/
│   └── e2b-solana-clawd/      # E2B deployment template
│       ├── deploy.ts
│       ├── e2b.toml
│       └── startup.sh
├── template/                   # Base deployment template
├── gateway/                   # Gateway services
├── payments/                   # Payment processing
└── SOLANA_CLAWD_SHELL.md      # Integration guide
```

## Components

### MCP Server (`orchestrator/solana-clawd-mcp`)

31 tools across 5 categories:

| Category | Tools |
|----------|-------|
| Helius RPC | account_info, balance, transactions, priority_fee |
| Solana Market | price, trending, token_info, wallet_pnl |
| Trading | pump_token_scan, pump_buy_quote, pump_sell_quote |
| Memory | memory_recall, memory_write |
| Wallet | balance, address, transfer |

### Agentic Wallet (`orchestrator/privy-agentic-wallet`)

- Privy MPC wallet integration
- Transaction signing
- Balance monitoring
- Multi-wallet support

### E2B Deployment (`deploy/e2b-solana-clawd`)

Ready-to-deploy cloud sandbox with:
- Auto-installed dependencies
- MCP server
- Wallet services
- Environment variable injection

## Environment Variables

```bash
# Required
HELIUS_API_KEY=          # Helius RPC/DAS API key
HELIUS_RPC_URL=           # Helius mainnet RPC

# Optional
XAI_API_KEY=              # xAI Grok API key
SOLANA_PRIVATE_KEY=        # Trading wallet key
PRIVY_APP_ID=             # Privy app ID
OPENROUTER_API_KEY=       # OpenRouter routing
E2B_API_KEY=              # E2B deployment
```

## Documentation

- [Integration Guide](./SOLANA_CLAWD_SHELL.md) - Full architecture overview
- [MCP Server](./orchestrator/solana-clawd-mcp/) - Tool documentation
- [Privy Wallet](./orchestrator/privy-agentic-wallet/) - Wallet integration
- [E2B Deploy](./deploy/e2b-solana-clawd/) - Cloud deployment guide

## License

MIT - See individual component licenses
