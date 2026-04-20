# OpenClawd × ClawdRouter integration

How the sandbox orchestrator and the x402/MPP/AP2/A2A payments gateway fit together.

## The whole loop, one paragraph

A user logs into `solanaclawd.com` with Privy. Their Solana wallet is pulled off the JWT. The frontend calls `POST /v1/launch` with `monetize: true` — the orchestrator spawns an E2B sandbox from the `clawd` template, registers the agent on-chain in `clawd-vault` (owner = the user's Solana wallet, manifest pinned to IPFS), and mints an **AP2 intent mandate** signed with `PRIVY_AUTH_PRIVATE_KEY` authorising the sandbox to spend up to $5/day on paid agent calls. The mandate is injected as `CLAWD_MANDATE_JWT` in the sandbox env. Inside the sandbox, agent sessions get a `pay()` method that attaches the mandate to every outbound call; receipts are written to the Clawd vault as LEARNED memory. Other users anywhere on the internet can pay to call this agent at `solanaclawd.com/x402/agents/by-privy/<sub>` — the worker resolves the Privy sub back to a Solana wallet via a Pinata-hosted index, charges the caller (with $CLAWD holder discount applied), forwards to the sandbox gateway, and 70% of the revenue lands in the user's vault ATA ready to sweep.

## Key decision: AP2 is the ONLY outbound protocol from sandboxes

x402 and MPP both require the client to sign a Solana transaction. Privy-managed wallets don't expose raw secrets to the sandbox, so direct signing isn't possible. **AP2 solves this by separating authorisation from execution** — the mandate authorises, the `clawd-vault` program executes the transfer from the user's on-chain vault PDA. This is why `SandboxPayments.pay()` throws if you pass `protocol: "x402"` or `"mpp"` — those paths are reserved for clients that hold their own keys (the SDK we built in the first turn).

Browsers can still use x402/MPP when the user actively signs. Agents, by architecture, must use AP2.

## Environment additions

Everything on top of your existing env:

```sh
# ── orchestrator ──────────────────────────────────────────────────────
ORCHESTRATOR_KEEPER_KEY=<base58 Solana secret>       # pays Anchor tx fees, no funds
CLAWD_VAULT_PROGRAM=<program id from anchor build>
CLAWD_REGISTRY_SEED=clawd-registry-v1                # default, matches Rust
PINATA_JWT=<existing>                                # already set
GATEWAY_ORIGIN=https://solanaclawd.com
HELIUS_RPC=https://mainnet.helius-rpc.com/?api-key=...
USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

# ── worker (ClawdRouter) ──────────────────────────────────────────────
# Public key of orchestrator's PRIVY_AUTH_PRIVATE_KEY in JWK form
AP2_VERIFIER_JWK={"kty":"EC","crv":"P-256","x":"...","y":"..."}
# Same PINATA_JWT that the orchestrator uses — worker needs it to resolve privy index
PINATA_JWT=<existing>

# ── sandbox (injected automatically by SandboxManager at launch) ──────
CLAWD_MANDATE_JWT=<minted at launch>                 # don't set manually
CLAWD_OWNER_WALLET=<user's Privy Solana wallet>
CLAWD_OWNER_SUB=<Privy sub>
CLAWD_ROUTER_ORIGIN=https://solanaclawd.com
CLAWD_USDC_MINT=<same as above>
```

## Files in this drop

| Path | What |
|---|---|
| `orchestrator/payments.ts` | On-chain registration, IPFS pinning, AP2 mandate minting |
| `orchestrator/routes.ts` | Adapted — new `/v1/agents/register`, `/v1/mandates/mint`, `/v1/earnings`, and monetisation hook in `/v1/launch` |
| `orchestrator/sandbox-manager.ts` | Adapted — injects mandate JWT + CLAWD_ROUTER_ORIGIN into sandbox env |
| `gateway/src/payments.ts` | `SandboxPayments` — the outbound payment client |
| `gateway/src/server.ts` | Adapted — new `/v1/x402/pay`, `/v1/x402/spend`, `/v1/x402/mandate` endpoints |
| `gateway/src/agents/registry.ts` | Adapted — threads payments into every AgentSession |
| `gateway/src/channels/telegram.ts` | Adapted — adds `/spend`, `/mandate`, `/pay`, `/pay-agent` commands |
| `worker-patch/privy-resolver.ts` | New module for the ClawdRouter worker — Privy sub → wallet |
| `worker-patch/index.ts.patch.md` | Explicit patch notes for `worker/src/index.ts` |

## Changes to the Anchor program (TODO)

The current `clawd-vault` program has `register_agent`, `update_agent`, `distribute`. For the AP2 custodial flow to work end-to-end you need to add:

- `deposit(amount)` — user deposits USDC into their vault PDA ATA
- `withdraw(amount)` — user withdraws their own funds at will
- `settle_mandate(mandate_hash, recipient, amount)` — called by the ClawdRouter worker after verifying an AP2 mandate. Transfers from user vault ATA → recipient ATA. Enforces a per-mandate daily limit on-chain.

The mandate hash is SHA-256 of the JWT. The program stores a small ring buffer of (hash, cumulative_spend, date) per user so the daily limit survives worker restarts.

Until these land, calling `SandboxPayments.pay()` will hit the gateway, verify the mandate, then fail at the settle step because `handleAp2CustodialFlow` is stubbed. Two staged rollout options:

1. **Fast path** — keep the operator keypair as the temporary signer. `handleAp2CustodialFlow` signs from a custodial operator ATA. Users deposit to that ATA explicitly; accounting is off-chain. Works today, trust us with your USDC.
2. **Right path** — add the three Anchor instructions. Trustless, limit-enforced, ~1 week of Anchor work.

Recommend shipping (1) for the first cohort of monetised agents, hardening to (2) before broad release.

## End-to-end test

```sh
# 1. User launches monetised agent
curl -X POST https://solanaclawd.com/api/v1/launch \
  -H "Authorization: Bearer $PRIVY_JWT" \
  -H "content-type: application/json" \
  -d '{ "agent": "vibe-coder", "monetize": true, "spendLimitUsd": 10 }'

# Response:
# { sandboxId, gatewayUrl, gatewayToken,
#   payments: { agentPda, manifestCid, mandateJwt, mandateExp } }

# 2. Someone else pays to call the agent
curl -X POST https://solanaclawd.com/x402/a2a/by-privy/$USER_SUB \
  -H "content-type: application/json" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"tasks/send",
    "params":{"message":{"role":"user","parts":[{"type":"text","text":"review this diff"}]},
              "metadata":{"skillId":"review"}}
  }'
# → 402 with x402 challenge, pay it, get the response

# 3. User's sandbox pays another agent
# Inside the sandbox (or from their authenticated session):
curl -X POST https://$SANDBOX_HOST:18789/v1/x402/pay \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -d '{ "url": "https://other-gateway.com/x402/agents/.../summarize", "protocol": "ap2" }'
# → body + signature + receiptCid

# 4. User checks earnings
curl https://solanaclawd.com/api/v1/earnings -H "Authorization: Bearer $PRIVY_JWT"
# → { pendingBaseUnits: "230000", asset: "USDC", decimals: 6 }

# 5. Admin sweeps
# (scheduled job hits /api/v1/sweep or runs the Anchor distribute instruction)
```

## Gotchas

**The keeper key is NOT the fund signer.** `ORCHESTRATOR_KEEPER_KEY` only pays lamport fees to execute `register_agent`. All USDC stays in program-derived ATAs. If the keeper key leaks, worst case an attacker spams useless `register_agent` txs and burns your SOL fee budget — no funds at risk.

**`AP2_VERIFIER_JWK` is PUBLIC.** Put it in `wrangler.jsonc` vars, not secrets. It's the counterpart to your `PRIVY_AUTH_PRIVATE_KEY`; if you haven't already derived it, use `jose` to convert the PEM to JWK.

**Mandate rotation.** Every new `/v1/launch` call mints a fresh mandate. The old one stays valid until its `exp`. If you want to revoke, add a mandate denylist keyed by `jti` (currently we don't set a `jti` — add `setJti(randomUUID())` in `mintMandate` when you're ready for revocation).

**Sandbox pause clears the local spend meter.** That's intentional — a new launch mints a new mandate, and the meter is per-mandate. If you want lifetime spend tracking, query the vault LEARNED tier for `payment:*` keys and sum them.

**Receipts are dual-written.** Every paid call gets a receipt both on IPFS (via the worker at settle time) and in the LEARNED tier. If you're debugging, the worker log will have the `x-clawd-receipt-cid`; `ipfs.solanaclawd.com/ipfs/<cid>` serves it.
