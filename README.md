# openclawd-stack

Solana × xAI Grok agentic trading engine — sandboxed through [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell), funded through Privy, narrated through Telegram, and powered by `$CLAWD` (`8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump`).

This repo ships two sibling projects:

## [`openclawd-stack/`](./openclawd-stack)

The full runtime stack — CLI, blueprint, sandbox, gateway, orchestrator, bridge, payments, docs. Built around [NemoClawd](./openclawd-stack/NemoClawd-main), the OpenClawd plugin for NVIDIA OpenShell.

| Directory | What it is |
|---|---|
| [`NemoClawd-main/`](./openclawd-stack/NemoClawd-main) | The `nemoclaw` CLI, blueprint, MCP server, Pump-Fun services, and the full [developer docs](./openclawd-stack/NemoClawd-main/docs). |
| [`bridge/`](./openclawd-stack/bridge) | Solana ⇄ Telegram narration bridge. |
| [`gateway/`](./openclawd-stack/gateway) | OpenShell gateway wiring. |
| [`orchestrator/`](./openclawd-stack/orchestrator) | Runtime orchestrator. |
| [`payments/`](./openclawd-stack/payments) | Payment-gated agent surfaces. |
| [`template/`](./openclawd-stack/template) | Sandbox template assets. |
| [`deploy/e2b-solana-clawd/`](./openclawd-stack/deploy/e2b-solana-clawd) | E2B deployment recipe. |
| [`docs/`](./openclawd-stack/docs) | Stack-level documentation. |
| [`OpenShell-main/`](./openclawd-stack/OpenShell-main), [`OpenShell-community/`](./openclawd-stack/OpenShell-community) | Vendored OpenShell sources used for builds. |

Start with [`openclawd-stack/NemoClawd-main/docs/get-started/quickstart.md`](./openclawd-stack/NemoClawd-main/docs/get-started/quickstart.md).

## [`Open-Clawd/`](./Open-Clawd)

Standalone libraries and programs around the Clawd payment scheme and vault.

| File / Dir | What it is |
|---|---|
| [`clawd-vault-master/`](./Open-Clawd/clawd-vault-master) | Clawd vault — the long-running observer runtime. |
| [`solana-clawd-x402/`](./Open-Clawd/solana-clawd-x402) | Solana x402 payment worker. |
| [`x402/`](./Open-Clawd/x402) | x402 Cloudflare Worker implementation. |
| [`clawd-vault-program.rs`](./Open-Clawd/clawd-vault-program.rs) | On-chain vault program (Rust). |
| [`client-sdk.ts`](./Open-Clawd/client-sdk.ts) | Client SDK. |
| [`gateway-index.ts`](./Open-Clawd/gateway-index.ts) | Gateway entry. |
| [`solana-x402-scheme.ts`](./Open-Clawd/solana-x402-scheme.ts) | Solana x402 scheme definition. |

## Install

```bash
npm install -g @mawdbotsonsolana/nemoclaw
nemoclaw doctor
nemoclaw launch
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
