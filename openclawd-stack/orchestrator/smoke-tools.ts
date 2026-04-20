// Tool-use smoke test — force a tool call by asking a question the LLM can't
// answer without hitting solana-tracker + jupiter. Verifies the gateway loop:
//   user → LLM → tool_calls → executeToolCall → LLM again → final answer.

import 'dotenv/config';
import { Sandbox } from 'e2b';
import WebSocket from 'ws';

const TEMPLATE = 'clawd';
const GATEWAY_PORT = 18789;
const TOKEN = 'local-smoke-token';
const CLAWD_MINT = '8cHzQHUS2s2h8TzCmfqPKYiM4dSt4roa3n7MyRLApump';

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY_FALLBACK;
  const heliusRpc =
    process.env.HELIUS_RPC_FALLBACK ?? process.env.HELIUS_RPC_URL ?? '';
  const solanaTrackerKey =
    process.env.SOLANA_TRACKER_KEY_FALLBACK ?? process.env.SOLANA_TRACKER_API_KEY ?? '';
  if (!openaiKey) throw new Error('OPENAI_API_KEY_FALLBACK missing');

  const sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 300_000 });
  console.log(`[tools] sandboxId=${sbx.sandboxId}`);

  try {
    const envsSh =
      [
        `export CLAWD_AUTH_MODE=token`,
        `export CLAWD_GATEWAY_TOKEN=${JSON.stringify(TOKEN)}`,
        `export OPENAI_API_KEY=${JSON.stringify(openaiKey)}`,
        heliusRpc ? `export HELIUS_RPC_URL=${JSON.stringify(heliusRpc)}` : '',
        solanaTrackerKey
          ? `export SOLANA_TRACKER_API_KEY=${JSON.stringify(solanaTrackerKey)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n') + '\n';
    await sbx.files.write('/var/lib/clawd/envs.sh', envsSh);
    await sbx.commands.run('bash -lc "pkill -x node || true"').catch(() => undefined);

    const host = sbx.getHost(GATEWAY_PORT);
    const base = `https://${host}`;
    const auth = { authorization: `Bearer ${TOKEN}` };

    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5_000) }).catch(
        () => null,
      );
      if (res?.ok) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }

    const mk = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ agent: 'clawd-trader', model: 'gpt-4o-mini' }),
    });
    if (!mk.ok) throw new Error(`session ${mk.status}: ${await mk.text()}`);
    const { sessionId } = (await mk.json()) as { sessionId: string };
    console.log(`[tools] sessionId=${sessionId}`);

    const ws = new WebSocket(
      `wss://${host}/?session=${sessionId}&token=${encodeURIComponent(TOKEN)}`,
    );

    const { toolCalls, finalContent } = await new Promise<{
      toolCalls: Array<{ name: string; result: string }>;
      finalContent: string;
    }>((resolve, reject) => {
      const collected: Array<{ name: string; result: string }> = [];
      let finalContent = '';
      const timer = setTimeout(() => reject(new Error('ws timeout')), 90_000);

      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            type: 'message',
            content:
              `Answer in under 60 words. Do both in one reply:\n` +
              `1) Call get_sol_balance for wallet GyZGtA7hEThVHZpj52XC9jX15a8ABtDHTwELjFRWEts4.\n` +
              `2) Call get_token_info for mint ${CLAWD_MINT} and tell me its symbol.`,
          }),
        );
      });
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as
          | { type: 'assistant_delta'; data: { content: string } }
          | { type: 'assistant_message'; data: { content: string } }
          | { type: 'tool_call_start'; data: { id: string; name: string; args: string } }
          | { type: 'tool_call_end'; data: { id: string; name: string; result: string } }
          | { type: 'error'; data: { message: string } }
          | { type: 'user_message' }
          | { type: 'interrupted' };
        if (msg.type === 'tool_call_start') {
          console.log(`[tools] → ${msg.data.name}(${msg.data.args})`);
        } else if (msg.type === 'tool_call_end') {
          console.log(`[tools] ← ${msg.data.name}: ${msg.data.result.slice(0, 120)}`);
          collected.push({ name: msg.data.name, result: msg.data.result });
        } else if (msg.type === 'assistant_delta') {
          process.stdout.write(msg.data.content);
        } else if (msg.type === 'assistant_message') {
          finalContent = msg.data.content;
          process.stdout.write('\n');
          clearTimeout(timer);
          ws.close();
          resolve({ toolCalls: collected, finalContent });
        } else if (msg.type === 'error') {
          clearTimeout(timer);
          ws.close();
          reject(new Error(msg.data.message));
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    console.log(`[tools] tool_calls=${toolCalls.length} final_len=${finalContent.length}`);
    if (toolCalls.length === 0) throw new Error('no tool calls emitted');
    const balanceCall = toolCalls.find((t) => t.name === 'get_sol_balance');
    const infoCall = toolCalls.find((t) => t.name === 'get_token_info');
    if (!balanceCall) throw new Error('expected get_sol_balance');
    if (!infoCall) throw new Error('expected get_token_info');
    // Both tools should return actual payload, not an `error` field.
    if (balanceCall.result.includes('"error"'))
      throw new Error(`get_sol_balance errored: ${balanceCall.result}`);
    if (infoCall.result.includes('"error"'))
      throw new Error(`get_token_info errored: ${infoCall.result}`);
  } finally {
    await Sandbox.kill(sbx.sandboxId).catch(() => undefined);
  }

  console.log('[tools] ✓ tool bridge works end-to-end');
}

main().catch((err) => {
  console.error('[tools] FAIL:', err);
  process.exit(1);
});
