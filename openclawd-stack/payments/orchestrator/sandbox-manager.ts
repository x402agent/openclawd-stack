// orchestrator/sandbox-manager.ts — adapted for payments.
//
// Diff summary vs the original:
//   + LaunchArgs.mandateJwt — AP2 mandate minted at launch time gets injected
//     into the sandbox env as CLAWD_MANDATE_JWT. The sandbox gateway reads this
//     from env and attaches it to every outbound x402 call.
//   + LaunchArgs.clawdRouterOrigin — configurable gateway origin (default
//     https://solanaclawd.com) so sandboxes in staging hit the right gateway.
//   + #buildEnvs populates both new values.
//
// Everything else is unchanged from the uploaded file.

import { Sandbox } from 'e2b';
import { SignJWT, importPKCS8 } from 'jose';
import type { HonchoClient } from './honcho.js';

const TEMPLATE = 'clawd';
const GATEWAY_PORT = 18789;
const IDLE_PAUSE_MS = 10 * 60_000;

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
      const saved = await this.#honcho.getSandboxPointer(args.privySub);
      if (saved?.sandboxId) {
        try {
          const sbx = await Sandbox.connect(saved.sandboxId);
          record = this.#register(args.privySub, sbx);
        } catch {
          /* sandbox was killed — fall through */
        }
      }
    }

    if (!record) {
      const sbx = await Sandbox.create(TEMPLATE, {
        envs: this.#buildEnvs(args),
        timeoutMs: 3600_000,
      });
      record = this.#register(args.privySub, sbx);

      const snap = await this.#honcho.getVaultSnapshot(args.privySub);
      if (snap) {
        await sbx.files.write('/var/lib/clawd/honcho-snapshot.json', JSON.stringify(snap));
      }
      await this.#startGateway(sbx);
    } else if (args.mandateJwt) {
      // Sandbox already live: push the fresh mandate into its env without a restart.
      await record.sandbox.commands.run(
        `sh -c 'echo "${args.mandateJwt}" > /var/lib/clawd/mandate.jwt && chmod 0600 /var/lib/clawd/mandate.jwt'`,
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

    try {
      const host = record.sandbox.getHost(GATEWAY_PORT);
      const token = await this.#mintGatewayJwt(privySub, null, 'orchestrator');
      const snap = (await fetch(`https://${host}/v1/vault/snapshot`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).then((r) => r.json())) as unknown;
      await this.#honcho.putVaultSnapshot(
        privySub,
        snap as Parameters<HonchoClient['putVaultSnapshot']>[1],
      );
    } catch (err) {
      console.error('[orchestrator] snapshot failed', err);
    }

    await Sandbox.kill(record.sandbox.sandboxId);
    this.#live.delete(privySub);
  }

  #register(privySub: string, sandbox: Sandbox): SandboxRecord {
    const record: SandboxRecord = { sandbox, privySub, lastActivity: Date.now(), pauseTimer: null };
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
      PRIVY_APP_ID: process.env.PRIVY_APP_ID ?? '',
      PRIVY_JWKS_ENDPOINT: process.env.PRIVY_JWKS_ENDPOINT ?? '',
      PRIVY_PUBLIC_KEY: process.env.PRIVY_PUBLIC_KEY ?? '',
      HONCHO_URL: process.env.HONCHO_URL ?? 'https://api.honcho.dev',
      HONCHO_API_KEY: process.env.HONCHO_API_KEY ?? '',
      // ─── payments ────────────────────────────────────────────────────
      CLAWD_ROUTER_ORIGIN:
        args.clawdRouterOrigin ?? process.env.GATEWAY_ORIGIN ?? 'https://solanaclawd.com',
      CLAWD_USDC_MINT:
        process.env.USDC_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    };

    if (args.mandateJwt) env.CLAWD_MANDATE_JWT = args.mandateJwt;
    if (args.wallet) env.CLAWD_OWNER_WALLET = args.wallet;

    if (args.userSecrets.openaiKey) env.OPENAI_API_KEY = args.userSecrets.openaiKey;
    if (args.userSecrets.anthropicKey) env.ANTHROPIC_API_KEY = args.userSecrets.anthropicKey;
    if (args.userSecrets.heliusRpc) env.HELIUS_RPC = args.userSecrets.heliusRpc;
    if (args.userSecrets.solanaTrackerKey) env.SOLANATRACKER_API_KEY = args.userSecrets.solanaTrackerKey;
    if (args.userSecrets.telegramBotToken && args.channels?.includes('telegram')) {
      env.TELEGRAM_BOT_TOKEN = args.userSecrets.telegramBotToken;
      env.TELEGRAM_ALLOW_CHAT_IDS = process.env.TELEGRAM_ALLOW_CHAT_IDS ?? '-1003338091119';
    }
    return env;
  }

  async #startGateway(sbx: Sandbox) {
    await sbx.commands.run('/usr/local/bin/clawd-entrypoint', { background: true });
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
    const key = await importPKCS8(this.#privyPrivateKeyPem, 'ES256');
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
