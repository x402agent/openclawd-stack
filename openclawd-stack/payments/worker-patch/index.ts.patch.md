// worker-patch/index.ts.patch.md
//
// Apply these edits to worker/src/index.ts in the solana-clawd-x402 scaffold.
// They add two things:
//
//   1. /agents/by-privy/:sub/*  — resolves a Privy sub to a Solana wallet,
//      then delegates to the existing gatedAgentCall flow.
//   2. /a2a/by-privy/:sub       — same resolution for A2A.
//
// Also required: set AP2_VERIFIER_JWK to the public half of the orchestrator's
// PRIVY_AUTH_PRIVATE_KEY so mandates minted by the orchestrator verify.

// ── ADD IMPORT AT TOP ────────────────────────────────────────────────────
import { resolvePrivySub } from "./solana/privy-resolver";

// ── REFACTOR: extend gatedAgentCall signature ───────────────────────────
// Change:
//   async function gatedAgentCall(c, opts: GateOpts): Promise<Response>
// To:
//   interface GateOpts { mode: "a2a" | "passthrough"; agentIdOverride?: string }
//   async function gatedAgentCall(c, opts: GateOpts): Promise<Response> {
//     const agentId = opts.agentIdOverride ?? c.req.param("id");
//     // ... rest unchanged
//   }

// ── ADD ROUTES (place near the existing /agents/:id/* handler) ─────────
app.all("/agents/by-privy/:sub/*", async (c) => {
  const sub = c.req.param("sub");
  const wallet = await resolvePrivySub(c.env, sub);
  if (!wallet) return c.json({ error: "privy sub not registered" }, 404);
  return gatedAgentCall(c, { mode: "passthrough", agentIdOverride: wallet });
});

app.post("/a2a/by-privy/:sub", async (c) => {
  const sub = c.req.param("sub");
  const wallet = await resolvePrivySub(c.env, sub);
  if (!wallet) return c.json({ error: "privy sub not registered" }, 404);
  return gatedAgentCall(c, { mode: "a2a", agentIdOverride: wallet });
});

app.get("/a2a/by-privy/:sub/.well-known/agent.json", async (c) => {
  const sub = c.req.param("sub");
  const wallet = await resolvePrivySub(c.env, sub);
  if (!wallet) return c.json({ error: "privy sub not registered" }, 404);
  const record = await getAgent(c.env, wallet);
  if (!record) return c.json({ error: "agent not found" }, 404);
  const card = await fetchAgentCard(c.env, record);
  return c.json(card, 200, { "cache-control": "public, max-age=60" });
});

// ── WRANGLER CONFIG ─────────────────────────────────────────────────────
// Add PINATA_JWT to wrangler.jsonc (already in the scaffold, double-check) and
// add AP2_VERIFIER_JWK pointing at the orchestrator's ES256 public key.
//
// Example (paste into wrangler.jsonc vars, not secrets — it's public):
//   "AP2_VERIFIER_JWK": "{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"...\",\"y\":\"...\"}"
//
// The orchestrator emits mandates with:
//   iss = "https://solanaclawd.com/orchestrator"
//   aud = "https://solanaclawd.com/x402"
//
// Make sure worker/src/protocols/ap2.ts#verifyMandate is called with audience
// "https://solanaclawd.com/x402" (strip any trailing slash) — this already
// matches how handleAp2UserFlow calls it using `new URL(c.req.url).origin`,
// but only if the request arrives at the root origin. If it arrives on
// solanaclawd.com/x402/*, update the audience computation:
//
//   const audience = `${new URL(c.req.url).origin}/x402`;
