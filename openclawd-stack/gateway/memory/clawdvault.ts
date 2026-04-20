// The Clawd vault — the canonical three-tier epistemological memory layer,
// backed by JSONL files under /vault and mirrored into Honcho v3.
//
//   KNOWN     — facts explicitly supplied by the user or asserted by an agent
//               with full provenance (wallet, holdings, team, etc.).
//   LEARNED   — conclusions derived from repeated interactions (user's trading
//               style, preferred coins, vibe-coding project context).
//   INFERRED  — hot, short-lived working memory; a single trade cycle, a tool
//               result, a scratchpad thought. Expires fast, promotable to LEARNED.
//
// Persistence layers (cheapest → most durable):
//   1. In-memory buffer — coalesces writes during a single sandbox session.
//   2. /vault JSONL     — survives gateway restart inside the sandbox.
//   3. Honcho session   — survives sandbox eviction, and Honcho reasons over
//                         it. KNOWN/LEARNED entries become messages in a
//                         dedicated "vault" session; the user peer accumulates
//                         durable representation.
//
// On sandbox pause the orchestrator calls snapshot() and stores a terse JSON
// copy in the user peer's metadata as a belt-and-braces backup. On resume the
// entrypoint calls the rehydrate script before the gateway starts accepting
// traffic.

import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Honcho } from '@honcho-ai/sdk';

export type Tier = 'KNOWN' | 'LEARNED' | 'INFERRED';

export interface Entry {
  tier: Tier;
  key: string;
  value: unknown;
  ts: number;
  provenance?: string;
}

export interface ClawdVaultOpts {
  /** Workspace root — user project files. Used for the snapshot manifest. */
  workspace: string;
  /** Vault root (default `/vault`). One JSONL per tier lives here. */
  vaultDir?: string;
  honchoUrl?: string;
  honchoApiKey?: string;
}

const TIER_FILES: Record<Tier, string> = {
  KNOWN: 'known.jsonl',
  LEARNED: 'learned.jsonl',
  INFERRED: 'inferred.jsonl',
};

export class ClawdVault {
  #opts: Required<ClawdVaultOpts>;
  #buffer = new Map<string, Entry[]>();
  #flushTimer: NodeJS.Timeout;
  #honcho: Honcho | null;

  constructor(opts: ClawdVaultOpts) {
    this.#opts = {
      honchoUrl: process.env.HONCHO_URL ?? 'https://api.honcho.dev',
      honchoApiKey: process.env.HONCHO_API_KEY ?? '',
      vaultDir: opts.vaultDir ?? process.env.CLAWD_VAULT_DIR ?? '/vault',
      ...opts,
    };
    this.#honcho = this.#opts.honchoApiKey
      ? new Honcho({
          apiKey: this.#opts.honchoApiKey,
          baseURL: this.#opts.honchoUrl,
          workspaceId: 'solanaclawd',
        })
      : null;
    void fs.mkdir(this.#opts.vaultDir, { recursive: true }).catch(() => undefined);

    // Periodic flush — drains KNOWN/LEARNED to Honcho + trims INFERRED
    this.#flushTimer = setInterval(() => {
      void this.flushAll().catch(() => undefined);
    }, 30_000);
    this.#flushTimer.unref?.();
  }

  /** Ask Honcho what it knows about the owner, optionally scoped to one
   *  agent's session. Returns null if Honcho hasn't accrued enough signal. */
  async brainAsk(owner: string, query: string, agent?: string): Promise<string | null> {
    if (!this.#honcho) return null;
    try {
      const peer = await this.#honcho.peer(`user:${owner}`);
      const session = agent
        ? await this.#honcho.session(`sandbox:${owner}:${agent}`)
        : undefined;
      const answer = await peer.chat(query, session ? { session } : undefined);
      return typeof answer === 'string' ? answer : null;
    } catch {
      return null;
    }
  }

  writeKnown(owner: string, entry: Omit<Entry, 'tier' | 'ts'>) {
    this.#push(owner, { ...entry, tier: 'KNOWN', ts: Date.now() });
  }
  writeLearned(owner: string, entry: Omit<Entry, 'tier' | 'ts'>) {
    this.#push(owner, { ...entry, tier: 'LEARNED', ts: Date.now() });
  }
  writeInferred(owner: string, data: object) {
    this.#push(owner, {
      tier: 'INFERRED',
      key: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      value: data,
      ts: Date.now(),
    });
  }

  #push(owner: string, entry: Entry) {
    const k = `${owner}:${entry.tier}`;
    const arr = this.#buffer.get(k) ?? [];
    arr.push(entry);
    this.#buffer.set(k, arr);
    // Fire-and-forget append to the tier's JSONL so a sandbox crash still
    // preserves at-rest state until the next Honcho flush picks it up.
    this.#appendToDisk(owner, entry).catch(() => undefined);
  }

  async #appendToDisk(owner: string, entry: Entry): Promise<void> {
    const file = path.join(this.#opts.vaultDir, TIER_FILES[entry.tier]);
    const line = `${JSON.stringify({ owner, ...entry })}\n`;
    await fs.appendFile(file, line, { encoding: 'utf8' });
  }

  async read(owner: string, tier: Tier): Promise<Entry[]> {
    const local = this.#buffer.get(`${owner}:${tier}`) ?? [];
    const [onDisk, remote] = await Promise.all([
      this.#readFromDisk(owner, tier),
      this.#honchoFetch(owner, tier),
    ]);
    return [...remote, ...onDisk, ...local];
  }

  async #readFromDisk(owner: string, tier: Tier): Promise<Entry[]> {
    const file = path.join(this.#opts.vaultDir, TIER_FILES[tier]);
    try {
      const text = await fs.readFile(file, 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            const obj = JSON.parse(l) as Entry & { owner?: string };
            if (obj.owner && obj.owner !== owner) return [];
            return [{ tier, key: obj.key, value: obj.value, ts: obj.ts, provenance: obj.provenance }];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  async #honchoFetch(owner: string, _tier: Tier): Promise<Entry[]> {
    // KNOWN / LEARNED live as messages in the vault session. We don't refetch
    // on every read — local JSONL + in-memory buffer are the hot paths. This
    // method exists so callers can force a pull on sandbox resume; Honcho's
    // representation is where the long-term reasoning happens.
    if (!this.#honcho) return [];
    try {
      // Returning [] keeps read() fast; rehydration uses the snapshot stored
      // in the user peer's metadata, not per-tier message replays.
      void owner;
      return [];
    } catch {
      return [];
    }
  }

  // Promote LEARNED/KNOWN buffers to Honcho; drop INFERRED older than TTL
  async flushAll() {
    const promotions: Array<Promise<unknown>> = [];
    for (const [k, entries] of this.#buffer.entries()) {
      const [owner, tier] = k.split(':') as [string, Tier];
      if (tier === 'INFERRED') {
        const cutoff = Date.now() - 5 * 60_000;
        this.#buffer.set(k, entries.filter((e) => e.ts > cutoff));
        continue;
      }
      if (entries.length === 0) continue;
      promotions.push(this.#honchoWrite(owner, tier, entries));
      this.#buffer.set(k, []);
    }
    await Promise.allSettled(promotions);
  }

  async #honchoWrite(owner: string, tier: Tier, entries: Entry[]) {
    if (!this.#honcho || entries.length === 0) return;
    try {
      const [peer, session] = await Promise.all([
        this.#honcho.peer(`user:${owner}`),
        this.#honcho.session(`vault:${owner}`),
      ]);
      // Each entry becomes a message attributed to the user peer, tagged with
      // its tier + key in metadata. Honcho's reasoner pulls salient conclusions
      // out of this stream; the /v1/brain/ask endpoint queries the result.
      const messages = entries.map((e) =>
        peer.message(`[${tier}] ${e.key}: ${renderValue(e.value)}`, {
          metadata: {
            tier,
            key: e.key,
            provenance: e.provenance ?? null,
            ts: e.ts,
          },
        }),
      );
      await session.addMessages(messages);
    } catch (err) {
      // Never let Honcho failures block the sandbox — JSONL on disk is the
      // source of truth until a successful flush.
      console.error('[clawdvault] honcho write failed', err);
    }
  }

  async snapshot(owner: string): Promise<{
    owner: string;
    tiers: Record<Tier, Entry[]>;
    workspace_manifest: string[];
  }> {
    await this.flushAll();
    const [known, learned, inferred, workspace_manifest] = await Promise.all([
      this.read(owner, 'KNOWN'),
      this.read(owner, 'LEARNED'),
      this.read(owner, 'INFERRED'),
      this.#workspaceManifest(owner),
    ]);
    return {
      owner,
      tiers: { KNOWN: known, LEARNED: learned, INFERRED: inferred },
      workspace_manifest,
    };
  }

  async #workspaceManifest(owner: string): Promise<string[]> {
    const dir = path.join(this.#opts.workspace, owner);
    try {
      const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile())
        .map((e) => path.join((e as { parentPath?: string }).parentPath ?? dir, e.name));
    } catch {
      return [];
    }
  }

  /** Overwrite the on-disk JSONL tier files from a snapshot payload. */
  async rehydrateFromSnapshot(snapshot: {
    owner: string;
    tiers: Record<Tier, Entry[]>;
  }): Promise<void> {
    for (const tier of ['KNOWN', 'LEARNED', 'INFERRED'] as Tier[]) {
      const file = path.join(this.#opts.vaultDir, TIER_FILES[tier]);
      const stream = createWriteStream(file, { flags: 'w' });
      for (const entry of snapshot.tiers[tier] ?? []) {
        stream.write(`${JSON.stringify({ owner: snapshot.owner, ...entry })}\n`);
      }
      await new Promise<void>((resolve, reject) =>
        stream.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
    }
  }
}

function renderValue(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
