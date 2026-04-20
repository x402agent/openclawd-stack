// Privy token verification.
//
// Two token types:
//   1. User JWT minted by Privy itself — verified against PRIVY_JWKS_ENDPOINT
//      (Privy rotates keys; we cache the JWKS with jose's createRemoteJWKSet).
//   2. Orchestrator-signed JWT — solanaclawd.com's backend signs short-lived
//      tokens with PRIVY_AUTH_PRIVATE_KEY so the sandbox can verify calls
//      from the orchestrator itself (pause/snapshot/admin). We verify those
//      with PRIVY_PUBLIC_KEY.
//
// CRITICAL: private keys NEVER live inside the sandbox. Only the public key
// and the JWKS URL are injected at Sandbox.create time.

import { createRemoteJWKSet, jwtVerify, importSPKI, type KeyLike } from 'jose';

export interface PrivySubject {
  sub: string;
  wallet: string | null;
  scopes: string[];
}

const PRIVY_APP_ID = process.env.PRIVY_APP_ID ?? '';
const PRIVY_JWKS_URL = process.env.PRIVY_JWKS_ENDPOINT ?? '';
const PRIVY_PUBLIC_KEY_PEM = process.env.PRIVY_PUBLIC_KEY ?? '';

if (!PRIVY_APP_ID || !PRIVY_JWKS_URL) {
  console.warn('[privy-auth] PRIVY_APP_ID or PRIVY_JWKS_ENDPOINT unset; privy auth disabled');
}

const jwks = PRIVY_JWKS_URL ? createRemoteJWKSet(new URL(PRIVY_JWKS_URL)) : null;

let orchestratorKey: KeyLike | null = null;
async function getOrchestratorKey(): Promise<KeyLike | null> {
  if (orchestratorKey) return orchestratorKey;
  if (!PRIVY_PUBLIC_KEY_PEM) return null;
  orchestratorKey = (await importSPKI(PRIVY_PUBLIC_KEY_PEM, 'ES256')) as KeyLike;
  return orchestratorKey;
}

export async function verifyPrivyToken(
  token: string,
  opts: { scope?: 'user' | 'orchestrator' } = {},
): Promise<PrivySubject> {
  // 1. Orchestrator scope: verify with public key, requires iss=solanaclawd.com
  if (opts.scope === 'orchestrator') {
    const key = await getOrchestratorKey();
    if (!key) throw new Error('orchestrator_key_unavailable');
    const { payload } = await jwtVerify(token, key, {
      issuer: 'solanaclawd.com',
      audience: 'clawd-gateway',
    });
    return {
      sub: String(payload.sub),
      wallet: (payload.wallet as string | undefined) ?? null,
      scopes: ['orchestrator'],
    };
  }

  // 2. User scope: verify against Privy JWKS
  if (!jwks) throw new Error('privy_jwks_unavailable');
  const { payload } = await jwtVerify(token, jwks, {
    issuer: 'privy.io',
    audience: PRIVY_APP_ID,
  });
  return {
    sub: String(payload.sub),
    wallet: pickSolanaWallet(payload),
    scopes: ['user'],
  };
}

function pickSolanaWallet(payload: Record<string, unknown>): string | null {
  const linked = payload.linked_accounts as
    | Array<{ type: string; chain_type?: string; address?: string }>
    | undefined;
  if (!linked) return null;
  const sol = linked.find((a) => a.type === 'wallet' && a.chain_type === 'solana');
  return sol?.address ?? null;
}
