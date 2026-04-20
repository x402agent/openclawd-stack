// Debug probe — spawn a sandbox, tail gateway stderr, try session create.
import 'dotenv/config';
import { Sandbox } from 'e2b';

const TOKEN = 'local-smoke-token';

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY_FALLBACK ?? '';
  const sbx = await Sandbox.create('clawd', {
    envs: {
      CLAWD_AUTH_MODE: 'token',
      CLAWD_GATEWAY_TOKEN: TOKEN,
      OPENAI_API_KEY: openaiKey,
    },
    timeoutMs: 300_000,
  });
  console.log(`sandbox=${sbx.sandboxId}`);

  try {
    // Wait for port
    await new Promise((r) => setTimeout(r, 5_000));

    // Probe gateway process + logs
    const ps = await sbx.commands.run(
      "bash -lc 'pgrep -af clawd-entrypoint || true; pgrep -af \"node.*server.js\" || true; ss -ltn'"
    );
    console.log('--- ps + ports ---');
    console.log(ps.stdout);

    const logs = await sbx.commands.run(
      "bash -lc 'ls -la /opt/clawd/gateway/dist/ 2>&1; echo ---; cat /opt/clawd/gateway/dist/server.js | head -5 2>&1 || echo NODIST; echo ---; journalctl -n 50 --no-pager 2>/dev/null | tail -30 || echo NOJOURNAL'"
    );
    console.log('--- dist + journal ---');
    console.log(logs.stdout);

    // Try session locally inside the sandbox
    const curl = await sbx.commands.run(
      `bash -lc 'curl -sv -X POST http://127.0.0.1:18789/v1/sessions -H "authorization: Bearer ${TOKEN}" -H "content-type: application/json" -d "{\\"agent\\":\\"vibe-coder\\",\\"model\\":\\"gpt-4o-mini\\"}" 2>&1 | tail -40'`
    );
    console.log('--- curl /v1/sessions ---');
    console.log(curl.stdout);
  } finally {
    await Sandbox.kill(sbx.sandboxId).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
