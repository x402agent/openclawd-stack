// gateway/src/payments.ts
//
// Runs INSIDE the sandbox. The gateway uses this whenever an agent wants to
// pay another x402-gated service — other ClawdRouter agents, paid MCP tools,
// MPP endpoints anywhere on the internet.
//
// Auth model:
//   - Every outbound call rides an AP2 mandate (X-AP2-Mandate header).
//   - The mandate was minted by the orchestrator at launch time and injected
//     as CLAWD_MANDATE_JWT env var. It carries the user's wallet, spend ceiling,
//     and expiry — verified by the ClawdRouter gateway, settled on-chain via
//     the user's vault PDA.
//   - There is NO Solana keypair in the sandbox. The settlement signer is the
//     clawd-vault program, acting on a mandate it trusts because the verifier
//     key (AP2_VERIFIER_JWK) is the public half of PRIVY_AUTH_PRIVATE_KEY.
//
// In-sandbox spend tracking is belt-and-braces — the mandate enforces the
// real ceiling server-side, but we keep a local meter so the agent has
// fast feedback ("you've used $4.20 of your $5 daily limit") without
// round-tripping.

import { readFileSync, existsSync } from 'node:fs';
import type { ClawdVault } from './memory/clawdvault.js';

export interface PaymentsOpts {
  vault: ClawdVault;
  /** Owner Privy sub — receipt entries go into this user's LEARNED tier. */
  owner: string;
  /** Owner Solana wallet — used as the on-chain identity for receipts. */
  ownerWallet: string | null;
  /** ClawdRouter gateway, e.g. https://solanaclawd.com/x402. */
  gatewayOrigin: string;
}

export interface PaidFetchArgs {
  url: string;
  method?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  /** Protocol hint — defaults to ap2 since that's what our mandate speaks. */
  protocol?: 'x402' | 'mpp' | 'ap2';
  /** Optional cap for this one call, in USDC base units. Overrides mandate only downward. */
  maxAmountBaseUnits?: bigint;
}

export interface PaidFetchResult {
  status: number;
  body: string;
  signature?: string;
  receiptCid?: string;
  amountPaid?: string;
  asset?: string;
}

interface PaymentReceipt {
  url: string;
  method: string;
  protocol: 'x402' | 'mpp' | 'ap2';
  amount: string;
  asset: string;
  signature: string;
  receiptCid?: string;
  ts: number;
  status: number;
}

const MANDATE_PATHS = [
  '/var/lib/clawd/mandate.jwt',
  '/run/secrets/clawd-mandate.jwt',
];

export class SandboxPayments {
  #opts: PaymentsOpts;
  /** Running total of what the current mandate has spent, in USDC base units. */
  #spentBaseUnits = 0n;
  /** Last mandate we saw — invalidate local meter when mandate rotates. */
  #mandateFingerprint: string | null = null;

  constructor(opts: PaymentsOpts) {
    this.#opts = opts;
  }

  /** Read the current AP2 mandate JWT. Env wins; /var/lib/clawd/mandate.jwt is a fallback. */
  currentMandate(): string | null {
    const fromEnv = process.env.CLAWD_MANDATE_JWT;
    if (fromEnv) return fromEnv;
    for (const p of MANDATE_PATHS) {
      if (existsSync(p)) return readFileSync(p, 'utf8').trim();
    }
    return null;
  }

  /** Pay for and fetch a remote resource. Writes a receipt to the vault. */
  async pay(args: PaidFetchArgs): Promise<PaidFetchResult> {
    const mandate = this.currentMandate();
    if (!mandate) throw new Error('no_mandate');
    this.#maybeResetMeter(mandate);

    const protocol = args.protocol ?? 'ap2';
    const headers: Record<string, string> = {
      'content-type': args.headers?.['content-type'] ?? 'application/json',
      'x-ap2-mandate': mandate,
      ...args.headers,
    };
    if (this.#opts.ownerWallet) headers['x-payer'] = this.#opts.ownerWallet;
    if (protocol === 'mpp') headers['accept'] = 'application/mpp+json';
    if (protocol === 'x402') headers['accept'] = 'application/x402+json';

    // First leg — no payment signature. Gateway emits 402 + challenge.
    const first = await fetch(args.url, { method: args.method ?? 'GET', headers, body: args.body });

    if (first.status !== 402) {
      return { status: first.status, body: await first.text() };
    }

    // Parse the challenge. The body is always JSON (works for x402, MPP, AP2).
    const challenge = await first.clone().json() as {
      accepts?: Array<{ maxAmountRequired: string; asset: string }>;
      methods?: Array<{ amount: string; asset: string }>;
      maxAmount?: string;
      asset?: string;
    };

    const requested = BigInt(
      challenge.accepts?.[0]?.maxAmountRequired ??
        challenge.methods?.[0]?.amount ??
        challenge.maxAmount ??
        '0',
    );
    const asset =
      challenge.accepts?.[0]?.asset ??
      challenge.methods?.[0]?.asset ??
      challenge.asset ??
      'USDC';

    const cap = args.maxAmountBaseUnits ?? requested;
    if (requested > cap) {
      throw new Error(`price ${requested} exceeds per-call cap ${cap}`);
    }

    // For AP2 flow, the second leg just re-presents the mandate — the ClawdRouter
    // verifies the mandate and has the vault program CPI the transfer. No client-side
    // Solana signing. For x402 or MPP we'd need a client-side keypair; that path is
    // blocked here because Privy wallets don't export raw secrets. Agents operating
    // custodially on a user's behalf MUST go through AP2.
    if (protocol !== 'ap2') {
      throw new Error(
        `sandbox cannot sign ${protocol} transactions directly — use protocol:"ap2"`,
      );
    }

    // AP2 retry — server will settle from the user's vault PDA based on the mandate.
    const second = await fetch(args.url, {
      method: args.method ?? 'GET',
      headers: { ...headers, 'x-ap2-intent': 'settle' },
      body: args.body,
    });

    const payResponse = second.headers.get('payment-response') ?? second.headers.get('payment-receipt');
    const receiptCid = second.headers.get('x-clawd-receipt-cid') ?? undefined;
    let signature: string | undefined;
    if (payResponse) {
      try {
        const parsed = JSON.parse(atob(payResponse)) as { signature?: string };
        signature = parsed.signature;
      } catch { /* header malformed — receipt still got written server-side */ }
    }

    const bodyText = await second.text();
    const receipt: PaymentReceipt = {
      url: args.url,
      method: args.method ?? 'GET',
      protocol,
      amount: requested.toString(),
      asset,
      signature: signature ?? '',
      receiptCid,
      ts: Date.now(),
      status: second.status,
    };

    // Track locally + persist to vault as LEARNED memory so the agent remembers
    // "we paid 0.01 USDC to summarize at 12:34, got back X"
    this.#spentBaseUnits += requested;
    this.#opts.vault.writeLearned(this.#opts.owner, {
      key: `payment:${receipt.ts}:${shorten(args.url)}`,
      value: receipt,
      provenance: 'sandbox-payments',
    });

    return {
      status: second.status,
      body: bodyText,
      signature,
      receiptCid,
      amountPaid: requested.toString(),
      asset,
    };
  }

  /** Resolve a Privy sub to the ClawdRouter-hosted agent URL. */
  agentUrlForPrivySub(sub: string): string {
    return `${this.#opts.gatewayOrigin.replace(/\/$/, '')}/x402/a2a/by-privy/${sub}`;
  }

  /** Current spend against the active mandate — for UI/telegram display. */
  localSpend(): { spent: string; asset: 'USDC' } {
    return { spent: this.#spentBaseUnits.toString(), asset: 'USDC' };
  }

  #maybeResetMeter(mandate: string) {
    // Fingerprint = last 16 chars of the JWT. Good enough to detect rotation
    // without importing a JWT parser here.
    const fp = mandate.slice(-16);
    if (this.#mandateFingerprint !== fp) {
      this.#mandateFingerprint = fp;
      this.#spentBaseUnits = 0n;
    }
  }
}

function shorten(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname.slice(0, 32)}`;
  } catch {
    return url.slice(0, 48);
  }
}
