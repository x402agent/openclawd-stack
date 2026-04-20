// gateway/src/agents/registry.ts — adapted for payments.
//
// Diff summary vs the original:
//   + AgentCreateArgs.payments — SandboxPayments is threaded through so agent
//     implementations can call `ctx.pay({ url, ... })` inside their tool loop.
//   + AgentSession exposes `pay` and `agentUrl` as instance methods, which
//     concrete agents (mawdbot, vibe-coder, etc.) can wire into their tool
//     definitions.
//   + Default stub echoes back a note about payment capability being available.

import { randomUUID } from 'node:crypto';
import type { ClawdVault } from '../memory/clawdvault.js';
import type { SandboxPayments, PaidFetchArgs, PaidFetchResult } from '../payments.js';

export interface AgentCreateArgs {
  privySub: string;
  wallet: string | null;
  model?: string;
  project?: string;
  vault: ClawdVault;
  /** Shared SandboxPayments instance. All paid outbound calls go through this. */
  payments: SandboxPayments;
}

export interface AgentHandler {
  key: string;
  description: string;
  createSession(args: AgentCreateArgs): Promise<AgentSession>;
}

type Event = { type: string; data?: unknown };

export class AgentSession {
  static #registry = new Map<string, AgentSession>();
  static get(id: string): AgentSession | undefined {
    return AgentSession.#registry.get(id);
  }

  readonly id: string = randomUUID();
  readonly owner: string;
  readonly model: string;
  readonly #subs = new Set<(ev: Event) => void>();
  #interrupted = false;

  /** Exposed to agent implementations — wrap this as a tool. */
  readonly pay: (args: PaidFetchArgs) => Promise<PaidFetchResult>;
  readonly agentUrlForPrivySub: (sub: string) => string;

  constructor(opts: { owner: string; model: string; payments: SandboxPayments }) {
    this.owner = opts.owner;
    this.model = opts.model;
    this.pay = (args) => opts.payments.pay(args);
    this.agentUrlForPrivySub = (sub) => opts.payments.agentUrlForPrivySub(sub);
    AgentSession.#registry.set(this.id, this);
  }

  subscribe(cb: (ev: Event) => void): () => void {
    this.#subs.add(cb);
    return () => this.#subs.delete(cb);
  }

  emit(ev: Event) {
    for (const cb of this.#subs) cb(ev);
  }

  interrupt() {
    this.#interrupted = true;
    this.emit({ type: 'interrupted' });
  }

  async send(content: string): Promise<string> {
    this.#interrupted = false;
    this.emit({ type: 'user_message', data: { content } });

    // Demonstrate the shape: if the message is prefixed with "pay:", treat it
    // as a paid fetch. Concrete agents replace this whole method with a real
    // LLM + tool-use loop.
    if (content.startsWith('pay:')) {
      const url = content.slice('pay:'.length).trim();
      try {
        const res = await this.pay({ url });
        const reply = `[${this.model}] paid ${res.amountPaid ?? '?'} ${res.asset ?? 'USDC'} → ${res.status}\n${res.body.slice(0, 400)}`;
        this.emit({ type: 'assistant_message', data: { content: reply } });
        return reply;
      } catch (err) {
        const reply = `[${this.model}] payment failed: ${(err as Error).message}`;
        this.emit({ type: 'assistant_message', data: { content: reply } });
        return reply;
      }
    }

    const reply = `[${this.model}] stub (pay:<url> to make a paid call): ${content.slice(0, 200)}`;
    this.emit({ type: 'assistant_message', data: { content: reply } });
    return reply;
  }
}

function makeStubHandler(key: string, description: string, defaultModel: string): AgentHandler {
  return {
    key,
    description,
    async createSession({ privySub, model, payments }: AgentCreateArgs) {
      return new AgentSession({ owner: privySub, model: model ?? defaultModel, payments });
    },
  };
}

class AgentRegistry {
  #handlers = new Map<string, AgentHandler>();
  register(handler: AgentHandler) {
    this.#handlers.set(handler.key, handler);
  }
  get(key: string): AgentHandler | undefined {
    return this.#handlers.get(key);
  }
  list(): Array<{ key: string; description: string }> {
    return Array.from(this.#handlers.values()).map(({ key, description }) => ({ key, description }));
  }
}

export const agentRegistry = new AgentRegistry();

const DEFAULT_MODEL = 'anthropic/claude-opus-4-7';
agentRegistry.register(
  makeStubHandler('mawdbot', 'Autonomous Solana trading agent — OODA loop', DEFAULT_MODEL),
);
agentRegistry.register(
  makeStubHandler('defi-scanner', 'Pump.fun + Raydium scanner', DEFAULT_MODEL),
);
agentRegistry.register(
  makeStubHandler('clawd-trader', 'Perps + spot on the $CLAWD ecosystem', DEFAULT_MODEL),
);
agentRegistry.register(
  makeStubHandler('vibe-coder', 'Project-aware coding assistant', DEFAULT_MODEL),
);
