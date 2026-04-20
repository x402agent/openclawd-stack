// Verify whether Sandbox.create envs reach the template start_cmd.
import 'dotenv/config';
import { Sandbox } from 'e2b';

async function main() {
  const sbx = await Sandbox.create('clawd', {
    envs: {
      CLAWD_AUTH_MODE: 'token',
      CLAWD_GATEWAY_TOKEN: 'xxx',
      OPENAI_API_KEY: 'test-key-marker',
    },
    timeoutMs: 120_000,
  });
  try {
    await new Promise((r) => setTimeout(r, 3_000));
    const pid = await sbx.commands.run("bash -lc 'pgrep -f server.js | head -1'");
    const gpid = pid.stdout.trim();
    console.log(`gateway pid=${gpid}`);
    const env = await sbx.commands.run(
      `bash -lc 'cat /proc/${gpid}/environ 2>/dev/null | tr "\\0" "\\n" | grep -E "^(CLAWD_|OPENAI_)" || echo NONE'`,
    );
    console.log('--- gateway process env (CLAWD_ / OPENAI_ only) ---');
    console.log(env.stdout);
    const shell = await sbx.commands.run("bash -lc 'env | grep -E \"^(CLAWD_|OPENAI_)\" || echo SHELL_NONE'");
    console.log('--- sbx.commands.run env (same vars) ---');
    console.log(shell.stdout);
  } finally {
    await Sandbox.kill(sbx.sandboxId).catch(() => undefined);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
