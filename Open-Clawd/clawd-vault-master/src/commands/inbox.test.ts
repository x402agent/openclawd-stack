import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inboxAddCommand } from './inbox.js';

function makeVault(): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'clawvault-inbox-'));
  fs.writeFileSync(
    path.join(vaultPath, '.clawvault.json'),
    JSON.stringify({ name: 'test-vault', categories: ['inbox'] }, null, 2),
    'utf-8'
  );
  return vaultPath;
}

const envSnapshot = {
  CLAWVAULT_PATH: process.env.CLAWVAULT_PATH
};

afterEach(() => {
  if (envSnapshot.CLAWVAULT_PATH === undefined) {
    delete process.env.CLAWVAULT_PATH;
  } else {
    process.env.CLAWVAULT_PATH = envSnapshot.CLAWVAULT_PATH;
  }
});

describe('inboxAddCommand', () => {
  it('adds inline content to inbox', async () => {
    const vaultPath = makeVault();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await inboxAddCommand({
        vaultPath,
        content: 'Email thread about API rollout timeline',
        title: 'API rollout email',
        source: 'email'
      });
      expect(result.id.startsWith('inbox/')).toBe(true);
      expect(fs.existsSync(result.path)).toBe(true);
      const file = fs.readFileSync(result.path, 'utf-8');
      expect(file).toContain('title: API rollout email');
      expect(file).toContain('source: email');
      expect(file).toContain('Email thread about API rollout timeline');
    } finally {
      logSpy.mockRestore();
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  it('reads stdin content when requested', async () => {
    const vaultPath = makeVault();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await inboxAddCommand({
        vaultPath,
        stdin: true,
        readStdin: () => 'Transcript export: customer requested SSO support.'
      });
      expect(fs.existsSync(result.path)).toBe(true);
      const file = fs.readFileSync(result.path, 'utf-8');
      expect(file).toContain('Transcript export: customer requested SSO support.');
    } finally {
      logSpy.mockRestore();
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });
});
