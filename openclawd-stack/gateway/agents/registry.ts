// Agent registry — real LLM loop with tool use.
//
// Each session keeps a rolling conversation in memory, calls OpenAI's
// chat/completions API with the `tools` parameter populated, and loops until
// the model stops emitting tool_calls. Tool results (helius / solana-tracker
// / jupiter wrappers under ../tools/) are appended to the conversation as
// role:"tool" messages so the model can reference them in its final answer.
// Every completed turn goes to the Clawd vault INFERRED tier.
//
// The endpoint is OPENAI_BASE_URL + /chat/completions so you can point this at
// OpenAI, OpenRouter, or the local clawdrouter (:8402) by just changing the
// env var — no code change needed.

import { randomUUID } from 'node:crypto';
import { Honcho } from '@honcho-ai/sdk';
import type { ClawdVault } from '../memory/clawdvault.js';
import type { SandboxPayments, PaidFetchArgs, PaidFetchResult } from '../payments.js';
import { TOOL_SCHEMAS, executeToolCall } from '../tools/registry.js';

// Honcho client for mirroring chat turns + reasoning on demand. Falls back to
// a no-op if HONCHO_API_KEY is not set.
const HONCHO_API_KEY = process.env.HONCHO_API_KEY ?? '';
const honchoClient: Honcho | null = HONCHO_API_KEY
  ? new Honcho({
      apiKey: HONCHO_API_KEY,
      baseURL: process.env.HONCHO_URL,
      workspaceId: 'solanaclawd',
    })
  : null;
const ASSISTANT_PEER_ID = 'clawd-assistant';

export interface AgentCreateArgs {
  privySub: string;
  wallet: string | null;
  model?: string;
  project?: string;
  vault: ClawdVault;
  /** Shared SandboxPayments instance. All paid outbound calls go through this. */
  payments: SandboxPayments;
  /** Agent key ("mawdbot" etc.). Used to namespace the Honcho session. */
  agentKey?: string;
}

export interface AgentHandler {
  key: string;
  description: string;
  systemPrompt: string;
  defaultModel: string;
  createSession(args: AgentCreateArgs): Promise<AgentSession>;
}

type Event =
  | { type: 'user_message'; data: { content: string } }
  | { type: 'assistant_delta'; data: { content: string } }
  | { type: 'assistant_message'; data: { content: string } }
  | { type: 'tool_call_start'; data: { id: string; name: string; args: string } }
  | { type: 'tool_call_end'; data: { id: string; name: string; result: string } }
  | { type: 'error'; data: { message: string } }
  | { type: 'interrupted' };

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

// Cap the tool loop so a runaway model can't burn unbounded upstream spend.
const MAX_TOOL_ROUNDS = 6;

// OPENAI_BASE_URL lets you swap between OpenAI, OpenRouter, or the local
// clawdrouter (http://127.0.0.1:8402/v1) without code changes. We always
// append /chat/completions.
const LLM_BASE_URL = (
  process.env.OPENAI_BASE_URL ??
  process.env.CLAWD_LLM_BASE_URL ??
  'https://api.openai.com/v1'
).replace(/\/$/, '');
const LLM_URL = `${LLM_BASE_URL}/chat/completions`;
const LLM_API_KEY =
  process.env.OPENAI_API_KEY ??
  process.env.CLAWD_LLM_API_KEY ??
  '';

export class AgentSession {
  static #registry = new Map<string, AgentSession>();
  static get(id: string): AgentSession | undefined {
    return AgentSession.#registry.get(id);
  }

  readonly id: string = randomUUID();
  readonly owner: string;
  readonly model: string;
  readonly agentKey: string;
  readonly #systemPrompt: string;
  readonly #vault: ClawdVault;
  readonly #history: ChatMessage[] = [];
  readonly #subs = new Set<(ev: Event) => void>();
  #interrupted = false;
  #abort: AbortController | null = null;

  /** Exposed to agent implementations — wrap this as a tool. */
  readonly pay: (args: PaidFetchArgs) => Promise<PaidFetchResult>;
  readonly agentUrlForPrivySub: (sub: string) => string;

  constructor(opts: {
    owner: string;
    model: string;
    systemPrompt: string;
    vault: ClawdVault;
    payments: SandboxPayments;
    agentKey?: string;
  }) {
    this.owner = opts.owner;
    this.model = opts.model;
    this.agentKey = opts.agentKey ?? 'default';
    this.#systemPrompt = opts.systemPrompt;
    this.#vault = opts.vault;
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
    this.#abort?.abort();
    this.emit({ type: 'interrupted' });
  }

  /**
   * Consume one OpenAI SSE stream response. Accumulates text content deltas
   * (emitting `assistant_delta` per chunk) and tool_call fragments. Returns
   * the final state once [DONE] (or stream end) is reached.
   */
  async #consumeStream(body: ReadableStream<Uint8Array>): Promise<{
    content: string;
    toolCalls: ToolCall[];
    finishReason: string | null;
  }> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason: string | null = null;
    // OpenAI streams tool_calls by index — each delta may append to function.name or
    // function.arguments. We accumulate by index then materialize at the end.
    const byIndex = new Map<number, ToolCall>();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    type?: 'function';
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string | null;
              }>;
            };
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            const delta = choice.delta ?? {};
            if (typeof delta.content === 'string' && delta.content.length > 0) {
              content += delta.content;
              this.emit({ type: 'assistant_delta', data: { content: delta.content } });
            }
            for (const tcDelta of delta.tool_calls ?? []) {
              const existing = byIndex.get(tcDelta.index) ?? {
                id: '',
                type: 'function' as const,
                function: { name: '', arguments: '' },
              };
              if (tcDelta.id) existing.id = tcDelta.id;
              if (tcDelta.function?.name) existing.function.name += tcDelta.function.name;
              if (tcDelta.function?.arguments) {
                existing.function.arguments += tcDelta.function.arguments;
              }
              byIndex.set(tcDelta.index, existing);
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          } catch {
            // Ignore malformed frames — keep-alives, etc.
          }
        }
      }
    }

    const toolCalls = [...byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc);
    return { content, toolCalls, finishReason };
  }

  async send(content: string): Promise<string> {
    this.#interrupted = false;
    this.emit({ type: 'user_message', data: { content } });

    // Shortcut: "pay:<url>" fires a paid fetch through the shared SandboxPayments
    // without going through the LLM. Useful from Telegram / bare curl flows.
    if (content.startsWith('pay:')) {
      const url = content.slice('pay:'.length).trim();
      try {
        const res = await this.pay({ url });
        const reply =
          `[${this.model}] paid ${res.amountPaid ?? '?'} ${res.asset ?? 'USDC'} → ${res.status}\n` +
          res.body.slice(0, 400);
        this.emit({ type: 'assistant_message', data: { content: reply } });
        return reply;
      } catch (err) {
        const reply = `[${this.model}] payment failed: ${(err as Error).message}`;
        this.emit({ type: 'error', data: { message: (err as Error).message } });
        return reply;
      }
    }

    this.#history.push({ role: 'user', content });

    if (!LLM_API_KEY) {
      const msg = '[no OPENAI_API_KEY configured — set it when launching the sandbox]';
      this.emit({ type: 'error', data: { message: msg } });
      this.#history.pop();
      return msg;
    }

    this.#abort = new AbortController();
    let reply = '';
    try {
      // Tool loop — each round streams from OpenAI, collects delta content
      // and tool_calls, executes any requested tools, appends results to
      // history, and calls OpenAI again. Exits when finish_reason is not
      // "tool_calls" (i.e. model produced a final answer).
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const messages: ChatMessage[] = [
          { role: 'system', content: this.#systemPrompt },
          ...this.#history,
        ];
        const res = await fetch(LLM_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${LLM_API_KEY}`,
            accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 1024,
            stream: true,
            tools: TOOL_SCHEMAS,
            tool_choice: 'auto',
            messages,
          }),
          signal: this.#abort.signal,
        });
        if (!res.ok || !res.body) {
          const body = res.ok ? '(no body)' : await res.text();
          throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
        }

        const { content, toolCalls, finishReason } = await this.#consumeStream(res.body);

        if (toolCalls.length > 0) {
          // Record the assistant turn that triggered tool use (OpenAI
          // requires this before the matching tool messages).
          this.#history.push({
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls,
          });

          for (const tc of toolCalls) {
            this.emit({
              type: 'tool_call_start',
              data: { id: tc.id, name: tc.function.name, args: tc.function.arguments },
            });
            const result = await executeToolCall(
              tc.function.name,
              tc.function.arguments,
              { pay: this.pay, agentUrlForPrivySub: this.agentUrlForPrivySub },
            );
            this.emit({
              type: 'tool_call_end',
              data: { id: tc.id, name: tc.function.name, result },
            });
            this.#history.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
          // Another round — the model will now see tool results.
          continue;
        }

        // No tool calls → this is the final answer.
        reply = content;
        void finishReason;
        break;
      }
    } catch (err) {
      if (this.#interrupted) return '';
      const msg = (err as Error).message;
      this.emit({ type: 'error', data: { message: msg } });
      this.#history.pop();
      return `[LLM error] ${msg}`;
    }

    this.#history.push({ role: 'assistant', content: reply });
    this.emit({ type: 'assistant_message', data: { content: reply } });

    // Every turn goes to INFERRED. The Dream agent (future) promotes salient
    // bits to LEARNED; the rest is pruned after the TTL.
    this.#vault.writeInferred(this.owner, {
      kind: 'chat-turn',
      agent: this.model,
      user: content,
      assistant: reply,
    });

    // Mirror the turn into Honcho so the user's representation and session
    // summaries build up continuously. Fire-and-forget — Honcho is durable
    // scaffolding, never on the critical path of the response.
    void persistTurn({
      owner: this.owner,
      agent: this.agentKey,
      user: content,
      assistant: reply,
      model: this.model,
    });

    return reply;
  }
}

async function persistTurn(args: {
  owner: string;
  agent: string;
  user: string;
  assistant: string;
  model: string;
}): Promise<void> {
  if (!honchoClient) return;
  try {
    const [userPeer, assistantPeer, session] = await Promise.all([
      honchoClient.peer(`user:${args.owner}`),
      honchoClient.peer(ASSISTANT_PEER_ID),
      honchoClient.session(`sandbox:${args.owner}:${args.agent}`),
    ]);
    await session.addMessages([
      userPeer.message(args.user),
      assistantPeer.message(args.assistant, { metadata: { model: args.model } }),
    ]);
  } catch (err) {
    console.error('[agent] honcho persist failed', err);
  }
}

const DEFAULT_MODEL =
  process.env.CLAWD_DEFAULT_MODEL ?? 'gpt-4o-mini';

// System prompts — short, focused. When the MCP tool bridge lands these will
// grow tool-use instructions; for now they just set the agent's persona.
const SYSTEM_PROMPTS: Record<string, string> = {
  mawdbot:
    'You are MawdBot, an autonomous Solana trading agent. OODA loop discipline: observe, orient, decide, act. Be decisive and terse.',
  'defi-scanner':
    'You are the DeFi Scanner. Classify tokens as SNIPE / BUY / SCALP / AVOID. Explain briefly, lead with the verdict.',
  'clawd-trader':
    'You are Clawd Trader — perps + spot specialist on the $CLAWD ecosystem. Hyperliquid, Aster, Jupiter. Speak in deltas and risk.',
  'vibe-coder':
    'You are Vibe Coder, a project-aware coding assistant. Short answers, code blocks when needed, no preamble.',
  'fire-crawler':
    'You are Fire Crawler, a Clawd-owned web research agent powered by Firecrawl. ' +
    'You can scrape any URL (`web_scrape`), search the open web (`web_search`), ' +
    'enumerate a site (`web_map`), and run full async crawls (`web_crawl` then `web_crawl_status`). ' +
    'Pick the smallest tool that answers the user — a scrape for one page, a search when they do not have a URL, ' +
    'a map before crawling. Always surface URLs, titles, and a short excerpt. Never invent sources.',
};

function makeHandler(
  key: string,
  description: string,
): AgentHandler {
  const systemPrompt =
    SYSTEM_PROMPTS[key] ?? `You are the ${key} agent. Be concise.`;
  return {
    key,
    description,
    systemPrompt,
    defaultModel: DEFAULT_MODEL,
    async createSession({ privySub, model, vault, payments, agentKey }: AgentCreateArgs) {
      return new AgentSession({
        owner: privySub,
        model: model ?? DEFAULT_MODEL,
        systemPrompt,
        vault,
        payments,
        agentKey: agentKey ?? key,
      });
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
    return Array.from(this.#handlers.values()).map(({ key, description }) => ({
      key,
      description,
    }));
  }
}

export const agentRegistry = new AgentRegistry();

agentRegistry.register(
  makeHandler('mawdbot', 'Autonomous Solana trading agent — OODA loop'),
);
agentRegistry.register(
  makeHandler('defi-scanner', 'Pump.fun + Raydium scanner'),
);
agentRegistry.register(
  makeHandler('clawd-trader', 'Perps + spot on the $CLAWD ecosystem'),
);
agentRegistry.register(
  makeHandler('vibe-coder', 'Project-aware coding assistant'),
);
agentRegistry.register(
  makeHandler(
    'fire-crawler',
    'Firecrawl-backed web research agent — scrape, search, map, and crawl any site',
  ),
);
