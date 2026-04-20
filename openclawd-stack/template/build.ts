// Build the `clawd` E2B template.
// Run: `pnpm build`  (needs E2B_API_KEY in the environment)

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CLAWD_TEMPLATE_NAME } from './template.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Stage the gateway source into the template's Docker build context so the
// Dockerfile can COPY it without escaping the context with `..`.
const stageRoot = path.join(here, '.build');
const stageGateway = path.join(stageRoot, 'gateway');
const gatewaySrc = path.resolve(here, '..', 'gateway');

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });
cpSync(gatewaySrc, stageGateway, {
  recursive: true,
  filter: (src) => !src.includes(`${path.sep}node_modules`) && !src.includes(`${path.sep}dist`),
});
console.log(`[openclawd] staged gateway → ${stageGateway}`);

const res = spawnSync(
  'pnpm',
  [
    'exec',
    'e2b',
    'template',
    'create',
    CLAWD_TEMPLATE_NAME,
    '--dockerfile',
    'Dockerfile',
    '--cmd',
    '/usr/local/bin/clawd-entrypoint',
    // Wait for the gateway to bind its port before marking the template ready.
    '--ready-cmd',
    "sh -c 'until ss -ltn 2>/dev/null | grep -q \":${CLAWD_GATEWAY_PORT:-18789} \"; do sleep 1; done'",
    '--cpu-count',
    '2',
    '--memory-mb',
    '4096',
  ],
  {
    cwd: here,
    stdio: 'inherit',
    env: process.env,
  },
);

if (res.status !== 0) {
  console.error(`[openclawd] template build failed (exit ${res.status ?? 'null'})`);
  process.exit(res.status ?? 1);
}
console.log(`\n[openclawd] template "${CLAWD_TEMPLATE_NAME}" published`);
