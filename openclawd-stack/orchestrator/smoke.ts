// End-to-end smoke test: spawn the `clawd` template, curl /healthz via the
// sandbox's public hostname, then kill it. Exits 0 on success.
//
// Run: E2B_API_KEY=... pnpm exec tsx smoke.ts

import 'dotenv/config';
import { Sandbox } from 'e2b';

const TEMPLATE = 'clawd';
const GATEWAY_PORT = 18789;

async function main() {
  console.log(`[smoke] creating sandbox from template "${TEMPLATE}"…`);
  const sbx = await Sandbox.create(TEMPLATE, { timeoutMs: 300_000 });
  console.log(`[smoke] sandboxId=${sbx.sandboxId}`);

  try {
    const host = sbx.getHost(GATEWAY_PORT);
    const url = `https://${host}/healthz`;
    console.log(`[smoke] polling ${url}`);

    let ok = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean };
          console.log(`[smoke] /healthz ->`, body);
          ok = body.ok === true;
          break;
        }
        console.log(`[smoke] attempt ${i + 1} -> ${res.status}`);
      } catch (err) {
        console.log(`[smoke] attempt ${i + 1} err: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (!ok) throw new Error('gateway never returned a healthy response');
  } finally {
    console.log(`[smoke] killing sandbox ${sbx.sandboxId}`);
    await Sandbox.kill(sbx.sandboxId).catch(() => undefined);
  }

  console.log('[smoke] ✓ template + gateway are live');
}

main().catch((err) => {
  console.error('[smoke] FAIL:', err);
  process.exit(1);
});
