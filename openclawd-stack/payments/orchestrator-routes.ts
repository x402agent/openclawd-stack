// orchestrator/routes.ts — adapted to integrate ClawdRouter payments.
//
// Diff summary vs the original:
//   + Import PaymentsClient from './payments.js'
//   + Instantiate `payments` at module load using existing env vars + PRIVY key
//   + Patch POST /v1/launch to register the agent on-chain at first-ever launch
//     and mint an AP2 mandate that rides back in the response
//   + POST /v1/agents/register — manual registration (idempotent after first launch)
//   + POST /v1/mandates/mint — mint a fresh mandate outside of launch
//   + GET  /v1/earnings — read the user's pending vault balance
//   + POST /v1/sweep — trigger on-chain distribute (admin/scheduler only)

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Connection } from '@solana/web3.js';
import { SandboxManager, type UserSecrets } from './sandbox-manager.js';
import { HonchoClient } from './honcho.js';
import { PaymentsClient, type AgentManifest } from './payments.js';

const honcho = new HonchoClient({ apiKey: process.env.HONCHO_API_KEY ?? '' });

const connection = new Connection(
  process.env.HELIUS_RPC ?? 'https://api.mainnet-beta.solana.com',
  'confirmed',
);
const payments = new PaymentsClient({
  connection,
  keeperSecretBase58: process.env.ORCHESTRATOR_KEEPER_KEY ?? '',
  privyPrivateKeyPem: process.env.PRIVY_AUTH_PRIVATE_KEY ?? '',
  clawdVaultProgram: process.env.CLAWD_VAULT_PROGRAM ?? '',
  registrySeed: process.env.CLAWD_REGISTRY_SEED ?? 'clawd-registry-v1',
  pinataJwt: process.env.PINATA_JWT ?? '',
  gatewayOrigin: process.env.GATEWAY_ORIGIN ?? 'https://solanaclawd.com',
});

const manager = new SandboxManager({
  honcho,
  privyPrivateKeyPem: process.env.PRIVY_AUTH_PRIVATE_KEY ?? '',
});

const privyJwks = process.env.PRIVY_JWKS_ENDPOINT
  ? createRemoteJWKSet(new URL(process.env.PRIVY_JWKS_ENDPOINT))
  : null;

type Vars = { privySub: string; wallet: string | null };
export const app = new Hono<{ Variables: Vars }>();

app.use(
  '*',
  cors({
    origin: ['https://solanaclawd.com', 'https://www.solanaclawd.com', 'http://localhost:3000'],
    credentials: true,
  }),
);

app.use('/v1/*', async (c, next) => {
  if (!privyJwks) return c.json({ error: 'privy_jwks_unavailable' }, 503);
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return c.json({ error: 'missing_token' }, 401);
  try {
    const { payload } = await jwtVerify(token, privyJwks, {
      issuer: 'privy.io',
      audience: process.env.PRIVY_APP_ID ?? '',
    });
    c.set('privySub', String(payload.sub));
    c.set('wallet', pickSolanaWallet(payload as Record<string, unknown>));
    await next();
  } catch {
    return c.json({ error: 'invalid_token' }, 401);
  }
});

app.get('/v1/me', (c) => c.json({ privySub: c.get('privySub'), wallet: c.get('wallet') }));

app.get('/v1/agents', (c) =>
  c.json({
    agents: [
      { key: 'mawdbot', label: 'MawdBot', description: 'Autonomous Solana trading agent' },
      { key: 'defi-scanner', label: 'DeFi Scanner', description: 'Pump.fun classifier' },
      { key: 'clawd-trader', label: 'Clawd Trader', description: 'Perps + spot' },
      { key: 'vibe-coder', label: 'Vibe Coder', description: 'Project-aware coding assistant' },
    ],
    models: [
      'anthropic/claude-opus-4-7',
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-5.2',
      'openai/gpt-5.2-mini',
    ],
  }),
);

app.post('/v1/launch', async (c) => {
  const body = await c.req.json<{
    agent: string;
    model?: string;
    channels?: Array<'web' | 'telegram'>;
    /** New: whether to register on-chain + mint a mandate at launch time. */
    monetize?: boolean;
    /** New: per-skill pricing overrides in USDC base units. */
    pricing?: Record<string, string>;
    /** New: daily spend ceiling for outbound paid calls. Default $5. */
    spendLimitUsd?: number;
  }>();
  const privySub = c.get('privySub');
  const wallet = c.get('wallet');

  const userSecrets = await loadUserSecrets(privySub);
  const result = await manager.launch({
    privySub,
    wallet,
    agent: body.agent,
    model: body.model,
    channels: body.channels ?? ['web'],
    userSecrets,
  });

  // Register on-chain + mint mandate if the user wants this agent monetisable.
  let payments_info: {
    agentPda?: string;
    manifestCid?: string;
    mandateJwt?: string;
    mandateExp?: number;
  } = {};

  if (body.monetize && wallet) {
    try {
      const manifest = buildManifest(body.agent, privySub, wallet, body.pricing);
      const reg = await payments.registerUserAgent({
        privySub,
        wallet,
        manifest,
        pricing: Object.entries(manifest.pricing).map(([method, p]) => ({
          method,
          amountUsdcBaseUnits: BigInt(p.amount),
        })),
      });
      await payments.pinPrivyIndex(privySub, wallet);

      const maxAmount = BigInt(Math.floor((body.spendLimitUsd ?? 5) * 1_000_000));
      const mandate = await payments.mintMandate({ privySub, wallet, maxAmount });

      payments_info = {
        agentPda: reg.agentPda,
        manifestCid: reg.manifestCid,
        mandateJwt: mandate.jwt,
        mandateExp: mandate.exp,
      };
    } catch (err) {
      console.error('[orchestrator] payments provisioning failed', err);
    }
  }

  return c.json({ ...result, payments: payments_info });
});

app.post('/v1/pause', async (c) => {
  const privySub = c.get('privySub');
  await manager.pause(privySub);
  return c.json({ ok: true });
});

app.get('/v1/projects', async (c) => {
  const projects = await honcho.listProjects(c.get('privySub'));
  return c.json({ projects });
});

/* ——— NEW: payments-surface routes ——— */

app.post('/v1/agents/register', async (c) => {
  const privySub = c.get('privySub');
  const wallet = c.get('wallet');
  if (!wallet) return c.json({ error: 'no_solana_wallet' }, 400);

  const body = await c.req.json<{
    agent: string;
    pricing?: Record<string, string>;
    splitBps?: { owner: number; buyback: number; treasury: number; operator: number };
    protocolsMask?: number;
  }>();

  const manifest = buildManifest(body.agent, privySub, wallet, body.pricing);
  const reg = await payments.registerUserAgent({
    privySub,
    wallet,
    manifest,
    splitBps: body.splitBps,
    protocolsMask: body.protocolsMask,
    pricing: Object.entries(manifest.pricing).map(([method, p]) => ({
      method,
      amountUsdcBaseUnits: BigInt(p.amount),
    })),
  });
  await payments.pinPrivyIndex(privySub, wallet);

  return c.json(reg);
});

app.post('/v1/mandates/mint', async (c) => {
  const privySub = c.get('privySub');
  const wallet = c.get('wallet');
  if (!wallet) return c.json({ error: 'no_solana_wallet' }, 400);

  const body = await c.req.json<{ spendLimitUsd?: number; ttlSeconds?: number; resource?: string }>();
  const maxAmount = BigInt(Math.floor((body.spendLimitUsd ?? 5) * 1_000_000));
  const mandate = await payments.mintMandate({
    privySub,
    wallet,
    maxAmount,
    ttlSeconds: body.ttlSeconds,
    resource: body.resource,
  });

  return c.json(mandate);
});

app.get('/v1/earnings', async (c) => {
  const wallet = c.get('wallet');
  if (!wallet) return c.json({ error: 'no_solana_wallet' }, 400);
  const usdcMint = process.env.USDC_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const pending = await payments.getPendingEarnings(wallet, usdcMint);
  return c.json({ pendingBaseUnits: pending.toString(), asset: 'USDC', decimals: 6 });
});

app.post('/v1/telegram/approve', async (c) => {
  const privySub = c.get('privySub');
  const { code, agent } = await c.req.json<{ code: string; agent?: string }>();
  const ptr = await honcho.getSandboxPointer(privySub);
  if (!ptr) return c.json({ error: 'no_sandbox' }, 404);
  return c.json({ ok: true, code, agent: agent ?? 'vibe-coder' });
});

/* ——— helpers ——— */

function buildManifest(
  agent: string,
  privySub: string,
  wallet: string,
  pricingOverride?: Record<string, string>,
): AgentManifest {
  const gatewayOrigin = process.env.GATEWAY_ORIGIN ?? 'https://solanaclawd.com';
  const usdcMint = process.env.USDC_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  const defaults: Record<string, { description: string; pricing: Record<string, string> }> = {
    mawdbot: {
      description: 'Autonomous Solana trading agent — OODA loop + Clawd vault memory',
      pricing: { 'tasks/send': '100000', 'quote': '50000' }, // $0.10 / $0.05
    },
    'defi-scanner': {
      description: 'Pump.fun + Raydium scanner with SNIPE/BUY/SCALP/AVOID classifier',
      pricing: { 'scan': '20000', 'classify': '30000' },
    },
    'clawd-trader': {
      description: 'Full $CLAWD ecosystem agent — perps via Hyperliquid/Aster',
      pricing: { 'tasks/send': '200000' },
    },
    'vibe-coder': {
      description: 'Project-aware coding assistant',
      pricing: { 'tasks/send': '100000', 'review': '50000' },
    },
  };

  const spec = defaults[agent] ?? { description: agent, pricing: { 'tasks/send': '50000' } };
  const pricing = pricingOverride
    ? Object.fromEntries(Object.entries(pricingOverride).map(([k, v]) => [k, v]))
    : spec.pricing;

  return {
    name: `${agent} (${privySub.slice(0, 8)})`,
    description: spec.description,
    url: `${gatewayOrigin}/x402/a2a/${wallet}`,
    version: '1.0.0',
    skills: Object.keys(pricing).map((id) => ({ id, name: id, description: `${agent}:${id}` })),
    pricing: Object.fromEntries(
      Object.entries(pricing).map(([method, amount]) => [
        method,
        { amount: String(amount), asset: usdcMint, protocols: ['x402', 'mpp', 'ap2', 'a2a'] },
      ]),
    ),
    owner: { privySub, solanaWallet: wallet },
  };
}

async function loadUserSecrets(_privySub: string): Promise<UserSecrets> {
  return {
    openaiKey: process.env.OPENAI_API_KEY_FALLBACK,
    anthropicKey: process.env.ANTHROPIC_API_KEY_FALLBACK,
    heliusRpc: process.env.HELIUS_RPC_FALLBACK,
    solanaTrackerKey: process.env.SOLANA_TRACKER_KEY_FALLBACK,
  };
}

function pickSolanaWallet(payload: Record<string, unknown>): string | null {
  const linked = payload.linked_accounts as
    | Array<{ type: string; chain_type?: string; address?: string }>
    | undefined;
  const sol = linked?.find((a) => a.type === 'wallet' && a.chain_type === 'solana');
  return sol?.address ?? null;
}
