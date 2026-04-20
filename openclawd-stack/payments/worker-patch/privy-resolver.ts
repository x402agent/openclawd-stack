// worker/src/solana/privy-resolver.ts
//
// Patch file — add this module to the ClawdRouter worker so other agents can
// address a user's Clawd agent by their Privy sub instead of their Solana
// pubkey. The orchestrator pins a tiny `{ privySub, wallet }` index to Pinata
// under a deterministic name at agent registration time; this module fetches
// it, caches it, and hands back the wallet so the registry can look up the
// agent PDA normally.
//
// Plug-in point (worker/src/index.ts):
//   app.all("/agents/by-privy/:sub/*", async (c) => {
//     const sub = c.req.param("sub");
//     const wallet = await resolvePrivySub(c.env, sub);
//     if (!wallet) return c.json({ error: "privy sub not registered" }, 404);
//     // delegate to existing /agents/:id/* handler with id = wallet
//     return gatedAgentCall(c, { mode: "passthrough", agentIdOverride: wallet });
//   });
//
// Same pattern for /a2a/by-privy/:sub and /a2a/by-privy/:sub/.well-known/agent.json.

import type { Env } from "../types";

interface PrivyIndex {
  privySub: string;
  wallet: string;
  updatedAt: number;
}

// Memory cache keyed by privySub — the worker's isolate persists long enough
// for this to be meaningful. On cold start we repopulate from Pinata.
const cache = new Map<string, { wallet: string; ts: number }>();
const TTL_MS = 5 * 60_000;

/**
 * Resolve a Privy sub to its Solana wallet owner.
 *
 * The index lives on Pinata with metadata `kind: privy-index, privySub: <sub>`.
 * We query Pinata's pinList endpoint to find it, then fetch the CID through the
 * custom gateway.
 */
export async function resolvePrivySub(env: Env, privySub: string): Promise<string | null> {
  const hit = cache.get(privySub);
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.wallet;

  // 1. Ask Pinata for the pin with the right metadata.
  const listUrl = new URL("https://api.pinata.cloud/data/pinList");
  listUrl.searchParams.set("metadata[keyvalues]", JSON.stringify({
    privySub: { value: privySub, op: "eq" },
    kind: { value: "privy-index", op: "eq" },
  }));
  listUrl.searchParams.set("pageLimit", "1");
  listUrl.searchParams.set("status", "pinned");

  const listRes = await fetch(listUrl, {
    headers: { authorization: `Bearer ${(env as Env & { PINATA_JWT?: string }).PINATA_JWT ?? ""}` },
    cf: { cacheTtl: 60, cacheEverything: true },
  });
  if (!listRes.ok) return null;
  const listBody = (await listRes.json()) as {
    rows: Array<{ ipfs_pin_hash: string }>;
  };
  const cid = listBody.rows?.[0]?.ipfs_pin_hash;
  if (!cid) return null;

  // 2. Fetch the index body from our own gateway.
  const gatewayRes = await fetch(`${env.PINATA_GATEWAY}/ipfs/${cid}`, {
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!gatewayRes.ok) return null;

  const index = (await gatewayRes.json()) as PrivyIndex;
  if (!index.wallet) return null;

  cache.set(privySub, { wallet: index.wallet, ts: Date.now() });
  return index.wallet;
}

/**
 * Invalidate the cache for a specific Privy sub. Call this from any admin endpoint
 * if an operator rotates a user's wallet.
 */
export function invalidatePrivySub(privySub: string): void {
  cache.delete(privySub);
}
