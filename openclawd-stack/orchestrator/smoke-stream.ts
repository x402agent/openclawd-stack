// WS streaming smoke test — spawn a sandbox, open a WS to the gateway, send a
// prompt, count the assistant_delta frames. Exits 0 if we see more than 1
// delta AND the final assistant_message.

import 'dotenv/config';
import { Sandbox } from 'e2b';
import WebSocket from 'ws';

const TEMPLATE = 'clawd';
const GATEWAY_PORT = 18789;
const TOKEN = 'local-smoke-token';

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY_FALLBACK;
  if (!openaiKey) throw new Error('OPENAI_API_KEY_FALLBACK missing');

  console.log('[stream] creating sandbox…');
  const sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 300_000 });
  console.log(`[stream] sandboxId=${sbx.sandboxId}`);

  try {
    // Rotate envs into the gateway via the supervisor.
    const envsSh =
      [
        `export CLAWD_AUTH_MODE=token`,
        `export CLAWD_GATEWAY_TOKEN=${JSON.stringify(TOKEN)}`,
        `export OPENAI_API_KEY=${JSON.stringify(openaiKey)}`,
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
      body: JSON.stringify({ agent: 'vibe-coder', model: 'gpt-4o-mini' }),
    });
    if (!mk.ok) throw new Error(`session ${mk.status}: ${await mk.text()}`);
    const { sessionId } = (await mk.json()) as { sessionId: string };
    console.log(`[stream] sessionId=${sessionId}`);

    // Open WS to the gateway. Node's `ws` client doesn't auto-negotiate
    // wss → e2b.app so we just pass the URL as-is.
    const wsUrl = `wss://${host}/?session=${sessionId}&token=${encodeURIComponent(TOKEN)}`;
    const ws = new WebSocket(wsUrl);

    const { deltas, finalContent } = await new Promise<{
      deltas: number;
      finalContent: string;
    }>((resolve, reject) => {
      let deltas = 0;
      let finalContent = '';
      const timer = setTimeout(() => reject(new Error('ws timeout')), 60_000);

      ws.on('open', () => {
        console.log('[stream] ws open, sending prompt');
        ws.send(
          JSON.stringify({
            type: 'message',
            content: 'Count out loud from one to ten, comma-separated.',
          }),
        );
      });
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as
          | { type: 'assistant_delta'; data: { content: string } }
          | { type: 'assistant_message'; data: { content: string } }
          | { type: 'user_message' }
          | { type: 'error'; data: { message: string } };
        if (msg.type === 'assistant_delta') {
          deltas++;
          process.stdout.write(msg.data.content);
        } else if (msg.type === 'assistant_message') {
          finalContent = msg.data.content;
          process.stdout.write('\n');
          clearTimeout(timer);
          ws.close();
          resolve({ deltas, finalContent });
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

    console.log(`[stream] deltas=${deltas} final_len=${finalContent.length}`);
    if (deltas < 2) throw new Error(`expected >1 delta, got ${deltas}`);
    if (!finalContent) throw new Error('no final assistant_message');
  } finally {
    console.log(`[stream] killing sandbox ${sbx.sandboxId}`);
    await Sandbox.kill(sbx.sandboxId).catch(() => undefined);
  }

  console.log('[stream] ✓ token-by-token streaming works');
}

main().catch((err) => {
  console.error('[stream] FAIL:', err);
  process.exit(1);
});
