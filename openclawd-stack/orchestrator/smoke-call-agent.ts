// call_agent smoke test — force the LLM to invoke the paid call_agent tool.
// Verifies wiring only; the underlying payment will either 402 (no mandate /
// no on-chain agent registered for the target sub) OR succeed if the full
// AP2 loop is provisioned. Either outcome confirms the bridge is live.

import 'dotenv/config';
import { Sandbox } from 'e2b';
import WebSocket from 'ws';

const TEMPLATE = 'clawd';
const GATEWAY_PORT = 18789;
const TOKEN = 'local-smoke-token';
const TARGET_SUB = 'did:privy:test-target-agent';

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY_FALLBACK;
  if (!openaiKey) throw new Error('OPENAI_API_KEY_FALLBACK missing');

  const sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 300_000 });
  console.log(`[ca] sandboxId=${sbx.sandboxId}`);

  try {
    const envsSh =
      [
        `export CLAWD_AUTH_MODE=token`,
        `export CLAWD_GATEWAY_TOKEN=${JSON.stringify(TOKEN)}`,
        `export OPENAI_API_KEY=${JSON.stringify(openaiKey)}`,
        // Minimal payments env so SandboxPayments doesn't choke at import.
        `export CLAWD_ROUTER_ORIGIN="https://solanaclawd.com"`,
        `export CLAWD_OWNER_SUB="did:privy:smoke-owner"`,
      ].join('\n') + '\n';
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

    const ws = new WebSocket(
      `wss://${host}/?session=${sessionId}&token=${encodeURIComponent(TOKEN)}`,
    );

    const { callAgentCall } = await new Promise<{ callAgentCall: string | null }>(
      (resolve, reject) => {
        let callAgentCall: string | null = null;
        const timer = setTimeout(() => reject(new Error('ws timeout')), 90_000);

        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'message',
              content:
                `Use the call_agent tool to ask agent with privy_sub="${TARGET_SUB}" ` +
                `the question "what is 2+2?". Cap the spend at 0.01 USDC. ` +
                `Then tell me what happened (including any error).`,
            }),
          );
        });
        ws.on('message', (raw: Buffer) => {
          const msg = JSON.parse(raw.toString()) as
            | { type: 'tool_call_start'; data: { name: string; args: string } }
            | { type: 'tool_call_end'; data: { name: string; result: string } }
            | { type: 'assistant_message'; data: { content: string } }
            | { type: 'error'; data: { message: string } }
            | { type: 'assistant_delta'; data: { content: string } }
            | { type: 'user_message' }
            | { type: 'interrupted' };
          if (msg.type === 'tool_call_start') {
            console.log(`[ca] → ${msg.data.name}(${msg.data.args})`);
          } else if (msg.type === 'tool_call_end') {
            console.log(`[ca] ← ${msg.data.name}: ${msg.data.result.slice(0, 300)}`);
            if (msg.data.name === 'call_agent') callAgentCall = msg.data.result;
          } else if (msg.type === 'assistant_delta') {
            process.stdout.write(msg.data.content);
          } else if (msg.type === 'assistant_message') {
            process.stdout.write('\n');
            clearTimeout(timer);
            ws.close();
            resolve({ callAgentCall });
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
      },
    );

    if (!callAgentCall) throw new Error('model did not call call_agent');
    console.log('[ca] call_agent result payload:');
    console.log(JSON.parse(callAgentCall));
  } finally {
    await Sandbox.kill(sbx.sandboxId).catch(() => undefined);
  }

  console.log('[ca] ✓ call_agent tool is wired');
}

main().catch((err) => {
  console.error('[ca] FAIL:', err);
  process.exit(1);
});
