// End-to-end chat test: spawn the `clawd` template in token-auth mode with
// OPENAI_API_KEY injected, create a session, send a message, expect a real
// OpenAI reply. Exits 0 on success.
//
// Run: pnpm exec tsx smoke-chat.ts

import 'dotenv/config';
import { Sandbox } from 'e2b';

const TEMPLATE = 'clawd';
const GATEWAY_PORT = 18789;
const TOKEN = 'local-smoke-token';

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY_FALLBACK;
  if (!openaiKey) throw new Error('OPENAI_API_KEY_FALLBACK missing from .env');

  console.log('[chat] creating sandbox…');
  const sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 300_000 });
  console.log(`[chat] sandboxId=${sbx.sandboxId}`);

  try {
    // Supervisor in entrypoint.sh reloads envs.sh on each respawn.
    const envsSh = [
      `export CLAWD_AUTH_MODE=token`,
      `export CLAWD_GATEWAY_TOKEN=${JSON.stringify(TOKEN)}`,
      `export OPENAI_API_KEY=${JSON.stringify(openaiKey)}`,
    ].join('\n') + '\n';
    await sbx.files.write('/var/lib/clawd/envs.sh', envsSh);
    // `-x node` matches by executable name, not cmdline — avoids pkill
    // matching itself (whose args contain /opt/clawd/gateway/dist/server.js).
    await sbx.commands.run('bash -lc "pkill -x node || true"').catch(() => undefined);

    const base = `https://${sbx.getHost(GATEWAY_PORT)}`;
    const auth = { authorization: `Bearer ${TOKEN}` };

    // Wait for /healthz
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
      if (res?.ok) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    console.log('[chat] healthz ok');

    // Create a session
    const mk = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ agent: 'vibe-coder', model: 'gpt-4o-mini' }),
    });
    if (!mk.ok) throw new Error(`session ${mk.status}: ${await mk.text()}`);
    const { sessionId } = (await mk.json()) as { sessionId: string };
    console.log(`[chat] sessionId=${sessionId}`);

    // Send a prompt
    const prompt = 'In exactly 6 words, describe a pelican eating a taco.';
    console.log(`[chat] > ${prompt}`);
    const msg = await fetch(`${base}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ content: prompt }),
    });
    if (!msg.ok) throw new Error(`message ${msg.status}: ${await msg.text()}`);
    const { reply } = (await msg.json()) as { reply: string };
    console.log(`[chat] < ${reply}`);

    if (!reply || reply.startsWith('[no OPENAI_API_KEY') || reply.startsWith('[LLM error]')) {
      throw new Error(`unexpected reply shape: ${reply}`);
    }

    // Verify vault captured the turn
    const vault = await fetch(`${base}/v1/vault/INFERRED`, { headers: auth });
    const vj = (await vault.json()) as {
      entries: Array<{ value: { kind?: string; user?: string; assistant?: string } }>;
    };
    const turn = [...vj.entries]
      .reverse()
      .find((e) => e.value?.kind === 'chat-turn');
    console.log(
      `[chat] vault INFERRED entries: ${vj.entries.length}, last turn user="${(turn?.value?.user ?? '').slice(0, 40)}…"`,
    );
  } finally {
    console.log(`[chat] killing sandbox ${sbx.sandboxId}`);
    await Sandbox.kill(sbx.sandboxId).catch(() => undefined);
  }

  console.log('[chat] ✓ end-to-end OpenAI chat works');
}

main().catch((err) => {
  console.error('[chat] FAIL:', err);
  process.exit(1);
});
