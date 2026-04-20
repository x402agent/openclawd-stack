// Runs on the solanaclawd.com backend (not inside E2B). Maps Privy user ->
// live sandbox. Handles the full lifecycle:
//
//   1. User authenticates on the frontend via Privy; backend gets their JWT + sub.
//   2. Client calls POST /launch with { agent, model, channels }.
//   3. SandboxManager looks up an existing paused sandbox for this Privy sub
//      in Honcho. If found and resumable -> resume. Otherwise -> create from
//      the 'clawd' template.
//   4. Inject per-user secrets (their OpenAI/Anthropic key from Privy Vault,
//      their Telegram token if they're connecting that channel, and a short-
//      lived orchestrator-signed JWT for inter-process admin calls).
//   5. Mint a short-lived Privy JWT scoped to `clawd-gateway` that the browser
//      uses to hit the sandbox gateway URL.
//   6. Idle for N min -> pause + snapshot Clawd vault to Honcho.

import { Sandbox } from 'e2b';
import { SignJWT, importPKCS8 } from 'jose';
import type { HonchoClient } from './honcho.js';

// Accept either a PEM PKCS8 blob or Privy's `wallet-auth:<base64>` format and
// normalize to PEM so `importPKCS8` accepts it.
function normalizePrivyPrivateKey(raw: string): string {
  const trimmed = raw.replace(/^wallet-auth:/, '').trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed;
  const wrapped = trimmed.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? trimmed;
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----`;
}

const TEMPLATE = 'clawd';
const GATEWAY_PORT = 18789;
const IDLE_PAUSE_MS = 10 * 60_000; // 10 min

/**
 * Envs forwarded verbatim from the orchestrator into every sandbox at launch.
 *
 * Removing a name here keeps that secret orchestrator-only. Anything listed is
 * set on the sandbox ONLY IF the orchestrator's own process env has it, so
 * leaving names here that aren't set is harmless.
 *
 * Security posture: this block is deliberately wide — the sandbox is a
 * single-tenant container for its owning Privy user, not a multi-tenant
 * environment. Revisit if you ever share a sandbox across users.
 */
const SANDBOX_PASSTHROUGH_ENVS = [
  // Privy — full server surface so the sandbox can call Privy REST itself
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET',
  'PRIVY_JWKS_ENDPOINT',
  'PRIVY_CLIENT_ID',
  'PRIVY_AUTH_PRIVATE_KEY',
  'PRIVY_PUBLIC_KEY',
  'PRIVY_AUTH_KEY_ID',

  // Cloudflare Images — agents can upload/serve images
  'HOSTED_IMAGES_ACCOUNT_ID',
  'HOSTED_IMAGES_HASH',
  'HOSTED_IMAGES_DELIVERY_URL',
  'HOSTED_IMAGES_KEY',

  // Cloudflare R2 — agents can read/write the user's R2 buckets
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_TOKEN_VALUE',

  // Firecrawl — web_scrape / web_search / web_map / web_crawl tools
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_BASE_URL',
] as const;

export interface UserSecrets {
  openaiKey?: string;
  anthropicKey?: string;
  heliusRpc?: string;
  solanaTrackerKey?: string;
  telegramBotToken?: string;
}

export interface LaunchArgs {
  privySub: string;
  wallet: string | null;
  agent: string;
  model?: string;
  channels?: Array<'web' | 'telegram'>;
  userSecrets: UserSecrets;
  /** AP2 mandate JWT so the sandbox can pay other agents. */
  mandateJwt?: string;
  /** ClawdRouter origin, e.g. https://solanaclawd.com. Defaults from env. */
  clawdRouterOrigin?: string;
}

export interface LaunchResult {
  sandboxId: string;
  gatewayUrl: string;
  gatewayToken: string;
  expiresAt: number;
}

interface SandboxRecord {
  sandbox: Sandbox;
  privySub: string;
  lastActivity: number;
  pauseTimer: NodeJS.Timeout | null;
}

export class SandboxManager {
  #live = new Map<string, SandboxRecord>();
  #honcho: HonchoClient;
  #privyPrivateKeyPem: string;

  constructor(opts: { privyPrivateKeyPem: string; honcho: HonchoClient }) {
    this.#honcho = opts.honcho;
    this.#privyPrivateKeyPem = opts.privyPrivateKeyPem;
  }

  async launch(args: LaunchArgs): Promise<LaunchResult> {
    let record = this.#live.get(args.privySub);

    if (!record) {
      // Try to reconnect to a still-running sandbox from the Honcho pointer.
      // NOTE: `Sandbox.pause()`/`Sandbox.resume()` exist as REST endpoints but
      // are not yet on the TS SDK surface (as of e2b@1.13). Once they land we
      // should swap `connect` → `resume` so sandboxes survive TTL.
      const saved = await this.#honcho.getSandboxPointer(args.privySub);
      if (saved?.sandboxId) {
        try {
          const sbx = await Sandbox.connect(saved.sandboxId);
          record = this.#register(args.privySub, sbx);
        } catch {
          // Connect failed (sandbox killed) — fall through to create fresh.
        }
      }
    }

    if (!record) {
      const envs = this.#buildEnvs(args);
      const sbx = await Sandbox.create(TEMPLATE, {
        envs,
        timeoutMs: 3600_000,
      });
      record = this.#register(args.privySub, sbx);

      // Hydrate Clawd vault from Honcho if we have a prior snapshot
      const snap = await this.#honcho.getVaultSnapshot(args.privySub);
      if (snap) {
        await sbx.files.write('/var/lib/clawd/honcho-snapshot.json', JSON.stringify(snap));
      }
      await this.#startGateway(sbx, envs);
    } else if (args.mandateJwt) {
      // Sandbox already live: push the fresh mandate into its env without a restart.
      await record.sandbox.commands.run(
        `sh -c 'mkdir -p /var/lib/clawd && echo "${args.mandateJwt}" > /var/lib/clawd/mandate.jwt && chmod 0600 /var/lib/clawd/mandate.jwt'`,
      );
    }

    this.#touch(record);
    await this.#honcho.setSandboxPointer(args.privySub, record.sandbox.sandboxId);

    const gatewayToken = await this.#mintGatewayJwt(args.privySub, args.wallet, 'user');
    const host = record.sandbox.getHost(GATEWAY_PORT);
    return {
      sandboxId: record.sandbox.sandboxId,
      gatewayUrl: `https://${host}`,
      gatewayToken,
      expiresAt: Date.now() + 15 * 60_000,
    };
  }

  async pause(privySub: string): Promise<void> {
    const record = this.#live.get(privySub);
    if (!record) return;
    if (record.pauseTimer) clearTimeout(record.pauseTimer);

    // Ask the gateway to snapshot Clawd vault + write workspace manifest
    try {
      const host = record.sandbox.getHost(GATEWAY_PORT);
      const token = await this.#mintGatewayJwt(privySub, null, 'orchestrator');
      const snap = (await fetch(`https://${host}/v1/vault/snapshot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json())) as unknown;
      await this.#honcho.putVaultSnapshot(privySub, snap as Parameters<HonchoClient['putVaultSnapshot']>[1]);
    } catch (err) {
      console.error('[orchestrator] snapshot failed', err);
    }

    // TODO: swap to `record.sandbox.pause()` once the e2b TS SDK exposes
    // pause/resume on the instance. Until then we kill the sandbox after
    // snapshotting — next launch re-creates and rehydrates from Honcho.
    await Sandbox.kill(record.sandbox.sandboxId);
    this.#live.delete(privySub);
  }

  // ── internals ────────────────────────────────────────────────────────
  #register(privySub: string, sandbox: Sandbox): SandboxRecord {
    const record: SandboxRecord = {
      sandbox,
      privySub,
      lastActivity: Date.now(),
      pauseTimer: null,
    };
    this.#live.set(privySub, record);
    return record;
  }

  #touch(record: SandboxRecord) {
    record.lastActivity = Date.now();
    if (record.pauseTimer) clearTimeout(record.pauseTimer);
    record.pauseTimer = setTimeout(() => {
      this.pause(record.privySub).catch((err) =>
        console.error('[orchestrator] auto-pause', err),
      );
    }, IDLE_PAUSE_MS);
  }

  #buildEnvs(args: LaunchArgs): Record<string, string> {
    const env: Record<string, string> = {
      CLAWD_AUTH_MODE: 'privy',

      // ─── Privy (full set, including server-side secrets) ─────────────
      // Heads-up: PRIVY_APP_SECRET and PRIVY_AUTH_PRIVATE_KEY are sensitive.
      // They're forwarded so the sandbox can call Privy's server API
      // (wallet actions, user lookups) and mint AP2 mandates directly.
      // Drop specific names from SANDBOX_PASSTHROUGH_ENVS below if you'd
      // rather keep them orchestrator-only.
      HONCHO_URL: process.env.HONCHO_URL ?? 'https://api.honcho.dev',
      HONCHO_API_KEY: process.env.HONCHO_API_KEY ?? '',

      // ─── payments ────────────────────────────────────────────────────
      CLAWD_ROUTER_ORIGIN:
        args.clawdRouterOrigin ?? process.env.GATEWAY_ORIGIN ?? 'https://solanaclawd.com',
      CLAWD_USDC_MINT:
        process.env.USDC_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    };

    // Passthrough block — forward the full app env set to the sandbox.
    // Only keys that are actually set on the orchestrator are injected.
    for (const name of SANDBOX_PASSTHROUGH_ENVS) {
      const v = process.env[name];
      if (v) env[name] = v;
    }

    if (args.mandateJwt) env.CLAWD_MANDATE_JWT = args.mandateJwt;
    if (args.wallet) env.CLAWD_OWNER_WALLET = args.wallet;
    env.CLAWD_OWNER_SUB = args.privySub;
    if (args.userSecrets.openaiKey) env.OPENAI_API_KEY = args.userSecrets.openaiKey;
    if (args.userSecrets.anthropicKey) env.ANTHROPIC_API_KEY = args.userSecrets.anthropicKey;
    // Prefer the user's per-session Helius RPC, fall back to orchestrator default.
    if (args.userSecrets.heliusRpc) env.HELIUS_RPC = args.userSecrets.heliusRpc;
    else if (process.env.HELIUS_RPC) env.HELIUS_RPC = process.env.HELIUS_RPC;
    else if (process.env.HELIUS_RPC_FALLBACK) env.HELIUS_RPC = process.env.HELIUS_RPC_FALLBACK;
    if (args.userSecrets.solanaTrackerKey)
      env.SOLANATRACKER_API_KEY = args.userSecrets.solanaTrackerKey;
    if (args.userSecrets.telegramBotToken && args.channels?.includes('telegram')) {
      env.TELEGRAM_BOT_TOKEN = args.userSecrets.telegramBotToken;
      env.TELEGRAM_ALLOW_CHAT_IDS =
        process.env.TELEGRAM_ALLOW_CHAT_IDS ?? '-1003338091119';
    }
    return env;
  }

  async #startGateway(sbx: Sandbox, envs: Record<string, string>) {
    // E2B runs the template's start_cmd (our supervisor loop) at spawn,
    // but WITHOUT the envs passed via Sandbox.create. We drop an envs.sh
    // and kill the child — the supervisor respawns it with fresh env.
    const envsShell = Object.entries(envs)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join('\n');
    await sbx.files.write('/var/lib/clawd/envs.sh', `${envsShell}\n`);
    // Signal the supervisor to respawn the child. `-x node` matches by
    // executable name, so the pkill command doesn't match itself.
    await sbx.commands
      .run('bash -lc "pkill -x node || true"')
      .catch(() => undefined);

    // Wait for the port to rebind after the respawn.
    for (let i = 0; i < 60; i++) {
      const probe = await sbx.commands.run(
        `bash -lc 'ss -ltn | grep -q ":${GATEWAY_PORT} " && echo ready || echo waiting'`,
      );
      if (probe.stdout.trim() === 'ready') return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('gateway_failed_to_start');
  }

  async #mintGatewayJwt(
    privySub: string,
    wallet: string | null,
    scope: 'user' | 'orchestrator',
  ): Promise<string> {
    const key = await importPKCS8(normalizePrivyPrivateKey(this.#privyPrivateKeyPem), 'ES256');
    return await new SignJWT({ wallet, scope })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject(privySub)
      .setIssuer('solanaclawd.com')
      .setAudience('clawd-gateway')
      .setIssuedAt()
      .setExpirationTime(scope === 'orchestrator' ? '2m' : '15m')
      .sign(key);
  }
}
