#!/usr/bin/env node
// Rehydrate the Clawd vault from a Honcho snapshot file.
// Usage: node rehydrate.js /var/lib/clawd/honcho-snapshot.json

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const VAULT_DIR = process.env.CLAWD_VAULT_DIR ?? '/vault';
const TIER_FILES = {
  KNOWN: 'known.jsonl',
  LEARNED: 'learned.jsonl',
  INFERRED: 'inferred.jsonl',
};

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: rehydrate.js <snapshot.json>');
    process.exit(1);
  }
  const text = await readFile(file, 'utf8');
  const snapshot = JSON.parse(text);
  if (!snapshot?.owner || !snapshot?.tiers) {
    console.error('invalid snapshot: missing owner/tiers');
    process.exit(1);
  }

  await mkdir(VAULT_DIR, { recursive: true });
  for (const tier of Object.keys(TIER_FILES)) {
    const entries = snapshot.tiers[tier] ?? [];
    const target = path.join(VAULT_DIR, TIER_FILES[tier]);
    const lines = entries
      .map((e) => JSON.stringify({ owner: snapshot.owner, ...e }))
      .join('\n');
    await writeFile(target, lines ? `${lines}\n` : '', 'utf8');
    console.log(`[rehydrate] ${tier}: ${entries.length} entries → ${target}`);
  }
}

main().catch((err) => {
  console.error('[rehydrate] failed:', err);
  process.exit(1);
});
