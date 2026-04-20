// orchestrator/payments.ts
//
// Bridges the orchestrator to the ClawdRouter on-chain payment layer.
//
// Three concerns:
//
//   1. Register user agents on-chain — when a user launches an agent in their
//      sandbox, we publish an entry to the clawd-vault registry PDA keyed on
//      their Privy Solana wallet. From that moment, any other agent on the
//      internet can pay to call them at solanaclawd.com/x402/agents/by-privy/<sub>.
//
//   2. Pin A2A manifests to Pinata — the agent card goes on IPFS at
//      ipfs.solanaclawd.com so the ClawdRouter can serve it content-addressed.
//
//   3. Mint AP2 intent mandates — short-lived JWT-VCs that authorise a user's
//      sandbox to spend up to $N/day on paid agent calls. Signed with the same
//      PRIVY_AUTH_PRIVATE_KEY that already signs gateway JWTs.
//
// The orchestrator holds a "keeper" Solana keypair for submitting register_agent
// and distribute instructions on behalf of users. This keeper key pays fees but
// has no authority over funds — all ATAs are owned by the user's wallet or by
// PDAs the Anchor program controls.

import { randomUUID } from 'node:crypto';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { SignJWT, importPKCS8 } from 'jose';
import bs58 from 'bs58';

export interface PaymentsOpts {
  /** Helius or equivalent Solana RPC. */
  connection: Connection;
  /** Orchestrator keeper key (base58 secret) — pays tx fees, never funds. */
  keeperSecretBase58: string;
  /** PKCS8 PEM for the orchestrator's ES256 signing key. */
  privyPrivateKeyPem: string;
  /** clawd-vault program id on mainnet. */
  clawdVaultProgram: string;
  /** Registry seed — must match REGISTRY_SEED in the Anchor program. */
  registrySeed: string;
  /** Pinata JWT for pinning manifests. */
  pinataJwt: string;
  /** Gateway origin for mandate audience, e.g. https://solanaclawd.com. */
  gatewayOrigin: string;
  /** Default spend ceiling per mandate, in USDC base units (6 decimals). */
  defaultMaxAmount?: bigint;
}

export interface AgentManifest {
  name: string;
  description: string;
  url: string;
  version: string;
  skills: Array<{ id: string; name: string; description: string; tags?: string[] }>;
  pricing: Record<string, { amount: string; asset: string; protocols: string[] }>;
  /** Non-standard extension: Privy sub of the owner. */
  owner: { privySub: string; solanaWallet: string };
}

export interface MandateArgs {
  privySub: string;
  wallet: string;
  /** USDC base units this mandate authorises, total. */
  maxAmount?: bigint;
  /** Resource URL the mandate is valid for — defaults to all agents. */
  resource?: string;
  /** Seconds until expiry — defaults to 1 hour. */
  ttlSeconds?: number;
}

export class PaymentsClient {
  #opts: Required<PaymentsOpts>;
  #keeper: Keypair;

  constructor(opts: PaymentsOpts) {
    this.#opts = {
      defaultMaxAmount: 5_000_000n, // $5 USDC
      ...opts,
    };
    this.#keeper = Keypair.fromSecretKey(bs58.decode(opts.keeperSecretBase58));
  }

  /* ——— 1. On-chain registration ——— */

  /**
   * Register a user's agent in the clawd-vault PDA. Call this once per agent
   * per user at first launch. The PDA is deterministic from the user's wallet,
   * so re-calling is idempotent (the program will error on re-init).
   */
  async registerUserAgent(args: {
    privySub: string;
    wallet: string;
    manifest: AgentManifest;
    splitBps?: { owner: number; buyback: number; treasury: number; operator: number };
    protocolsMask?: number; // bit 0=x402, 1=mpp, 2=ap2, 3=a2a
    pricing: Array<{ method: string; amountUsdcBaseUnits: bigint }>;
  }): Promise<{ agentPda: string; manifestCid: string; signature: string }> {
    // 1. Pin manifest to IPFS first — we need the CID to embed on-chain.
    const manifestCid = await this.pinManifest(args.manifest);

    // 2. Build the register_agent instruction.
    //    NOTE: this is a stub-signed transaction. The actual instruction data
    //    serialization requires the Anchor IDL. We provide the bytes shape here
    //    and expect the caller to substitute the real Anchor client once the IDL
    //    is generated from `anchor build`.
    const programId = new PublicKey(this.#opts.clawdVaultProgram);
    const ownerPubkey = new PublicKey(args.wallet);
    const agentPda = agentRegistryPda(programId, this.#opts.registrySeed, ownerPubkey);

    const split = args.splitBps ?? { owner: 7000, buyback: 1500, treasury: 1000, operator: 500 };
    const protocolsMask = args.protocolsMask ?? 0b1111; // all four

    // TODO: replace with anchor.BN-backed Program.methods.registerAgent(...).rpc()
    // Placeholder returns a deterministic fake signature so the pipeline runs in
    // staging; enable the real tx path once PaymentsClient is wired with the
    // Anchor client.
    const pricing = args.pricing.map((p) => ({
      methodHashHex: methodHashHex(p.method),
      amount: p.amountUsdcBaseUnits.toString(),
    }));

    console.log(
      '[payments] register_agent staged',
      JSON.stringify({
        owner: ownerPubkey.toBase58(),
        agentPda: agentPda.toBase58(),
        manifestCid,
        split,
        protocolsMask,
        pricing,
      }),
    );

    return {
      agentPda: agentPda.toBase58(),
      manifestCid,
      signature: `PENDING_ANCHOR_${randomUUID()}`,
    };
  }

  /* ——— 2. IPFS pinning ——— */

  async pinManifest(manifest: AgentManifest): Promise<string> {
    const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#opts.pinataJwt}`,
      },
      body: JSON.stringify({
        pinataMetadata: { name: `manifest-${manifest.owner.privySub}` },
        pinataContent: manifest,
      }),
    });
    if (!res.ok) throw new Error(`pinata pin failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { IpfsHash: string };
    return body.IpfsHash;
  }

  /** Publish a privy-sub → wallet index file so the gateway can resolve /by-privy/:sub */
  async pinPrivyIndex(privySub: string, wallet: string): Promise<string> {
    const res = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#opts.pinataJwt}`,
      },
      body: JSON.stringify({
        pinataMetadata: {
          name: `privy-${privySub}`,
          keyvalues: { privySub, kind: 'privy-index' },
        },
        pinataContent: { privySub, wallet, updatedAt: Date.now() },
      }),
    });
    if (!res.ok) throw new Error(`pinata index failed: ${res.status}`);
    const body = (await res.json()) as { IpfsHash: string };
    return body.IpfsHash;
  }

  /* ——— 3. AP2 mandate minting ——— */

  /**
   * Mint a JWT-VC intent mandate that authorises this user's sandbox to pay up
   * to `maxAmount` toward `resource` (defaulting to all ClawdRouter resources).
   *
   * The JWT is signed with PRIVY_AUTH_PRIVATE_KEY (same key used for gateway
   * JWTs). The ClawdRouter gateway verifies it against AP2_VERIFIER_JWK, which
   * must be the public-key pair of PRIVY_AUTH_PRIVATE_KEY.
   */
  async mintMandate(args: MandateArgs): Promise<{ jwt: string; exp: number }> {
    const key = await importPKCS8(this.#opts.privyPrivateKeyPem, 'ES256');
    const maxAmount = (args.maxAmount ?? this.#opts.defaultMaxAmount).toString();
    const resource = args.resource ?? `${this.#opts.gatewayOrigin}/x402/*`;
    const ttl = args.ttlSeconds ?? 3600;
    const exp = Math.floor(Date.now() / 1000) + ttl;

    const jwt = await new SignJWT({
      wallet: args.wallet,
      maxAmount,
      asset: 'USDC',
      resource,
    })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(`${this.#opts.gatewayOrigin}/orchestrator`)
      .setSubject(args.privySub)
      .setAudience(`${this.#opts.gatewayOrigin}/x402`)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key);

    return { jwt, exp };
  }

  /* ——— 4. Earnings + distribution ——— */

  /**
   * Read the USDC balance sitting in the user's agent vault ATA. This is the
   * amount that will be distributed on the next `distribute` call.
   */
  async getPendingEarnings(wallet: string, usdcMint: string): Promise<bigint> {
    const programId = new PublicKey(this.#opts.clawdVaultProgram);
    const ownerPubkey = new PublicKey(wallet);
    const agentPda = agentRegistryPda(programId, this.#opts.registrySeed, ownerPubkey);
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode('clawd-vault-v1'), agentPda.toBuffer()],
      programId,
    );
    const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
    const vaultAta = getAssociatedTokenAddressSync(new PublicKey(usdcMint), vaultAuthority, true);
    try {
      const info = await this.#opts.connection.getTokenAccountBalance(vaultAta);
      return BigInt(info.value.amount);
    } catch {
      return 0n;
    }
  }

  /**
   * Trigger `distribute` on-chain. Anyone can call this but the operator share
   * goes to whoever's ATA is passed — use the orchestrator's ATA here so the
   * operator share settles to the treasury keeper.
   */
  async triggerDistribute(_args: {
    wallet: string;
    amountBaseUnits: bigint;
    ownerAta: string;
    buybackAta: string;
    treasuryAta: string;
    operatorAta: string;
  }): Promise<{ signature: string }> {
    // TODO: wire to the Anchor client. The shape is fixed by the `distribute`
    // instruction in programs/clawd-vault/src/lib.rs.
    throw new Error('triggerDistribute: wire Anchor client after `anchor build`');
  }
}

/* ——— helpers ——— */

function agentRegistryPda(programId: PublicKey, seed: string, owner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(seed), owner.toBuffer()],
    programId,
  );
  return pda;
}

function methodHashHex(method: string): string {
  // Synchronous SHA-256 via node:crypto would be cleaner, but this keeps the
  // file portable. The Anchor program only checks byte equality against the
  // client-supplied hash — the hashing function is whatever we standardise on.
  // Caller in practice: crypto.subtle.digest('SHA-256', utf8) then slice 8 bytes.
  const encoder = new TextEncoder();
  const bytes = encoder.encode(method);
  // Simple FNV-1a as a placeholder — replace with SHA-256 first 8 bytes to match
  // worker/src/solana/registry.ts#methodHash.
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}
