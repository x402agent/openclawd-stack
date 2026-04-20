import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { globSync } from 'glob';
import { addInboxItem } from '../lib/inbox.js';
import { maintainCommand } from './maintain.js';

const envSnapshot = {
  CLAWVAULT_NO_LLM: process.env.CLAWVAULT_NO_LLM,
  CLAWVAULT_PATH: process.env.CLAWVAULT_PATH
};

function makeVault(): string {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'clawvault-maintain-'));
  fs.writeFileSync(
    path.join(vaultPath, '.clawvault.json'),
    JSON.stringify({
      name: 'maintain-test-vault',
      categories: ['inbox', 'decisions', 'lessons', 'facts', 'projects', 'people', 'commitments', 'preferences', 'research']
    }, null, 2),
    'utf-8'
  );
  return vaultPath;
}

function longCapture(): string {
  return [
    'During today’s planning session we decided to migrate the API gateway to a dedicated service.',
    'The team agreed this decision reduces release risk and gives us a cleaner rollback strategy.',
    'We also learned that our previous deployment checklist was too vague and caused inconsistent rollouts.',
    'A key fact is that production traffic spikes every weekday at 14:00 UTC and we need additional capacity before then.',
    'Next time we should document explicit validation gates and keep a single owner for the cutover sequence.',
    'This transcript includes enough context for distillation and should produce facts, decisions, and lessons.'
  ].join(' ');
}

afterEach(() => {
  if (envSnapshot.CLAWVAULT_NO_LLM === undefined) {
    delete process.env.CLAWVAULT_NO_LLM;
  } else {
    process.env.CLAWVAULT_NO_LLM = envSnapshot.CLAWVAULT_NO_LLM;
  }
  if (envSnapshot.CLAWVAULT_PATH === undefined) {
    delete process.env.CLAWVAULT_PATH;
  } else {
    process.env.CLAWVAULT_PATH = envSnapshot.CLAWVAULT_PATH;
  }
});

describe('maintainCommand', () => {
  it('runs all workers, writes log, and remains idempotent', async () => {
    process.env.CLAWVAULT_NO_LLM = '1';
    const vaultPath = makeVault();
    process.env.CLAWVAULT_PATH = vaultPath;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      addInboxItem(vaultPath, longCapture(), { title: 'Planning transcript', source: 'transcript' });
      addInboxItem(vaultPath, 'TODO: follow up with customer success on rollout email.', { title: 'Follow-up todo' });
      addInboxItem(vaultPath, 'TODO: follow up with customer success on rollout email.', { title: 'Follow-up todo duplicate' });

      const firstRun = await maintainCommand({ vaultPath });
      const workerNames = firstRun.workers.map((worker) => worker.worker).sort();
      expect(workerNames).toEqual(['curator', 'distiller', 'janitor', 'surveyor']);

      expect(fs.existsSync(firstRun.logPath)).toBe(true);
      const logContent = fs.readFileSync(firstRun.logPath, 'utf-8');
      expect(logContent).toContain('"worker":"curator"');
      expect(logContent).toContain('"worker":"janitor"');
      expect(logContent).toContain('"worker":"distiller"');
      expect(logContent).toContain('"worker":"surveyor"');

      const curated = globSync('**/inbox-*.md', {
        cwd: vaultPath,
        ignore: ['inbox/**', '.clawvault/**', 'ledger/**']
      });
      expect(curated.length).toBeGreaterThan(0);

      const distilledFacts = globSync('facts/distilled-*.md', { cwd: vaultPath });
      const distilledDecisions = globSync('decisions/distilled-*.md', { cwd: vaultPath });
      const distilledLessons = globSync('lessons/distilled-*.md', { cwd: vaultPath });
      expect(distilledFacts.length).toBeGreaterThan(0);
      expect(distilledDecisions.length).toBeGreaterThan(0);
      expect(distilledLessons.length).toBeGreaterThan(0);

      expect(fs.existsSync(path.join(vaultPath, '.clawvault', 'maintenance', 'janitor-report.md'))).toBe(true);
      expect(fs.existsSync(path.join(vaultPath, '.clawvault', 'maintenance', 'surveyor-report.md'))).toBe(true);
      const deduped = globSync('inbox/archive/deduped/*.md', { cwd: vaultPath });
      expect(deduped.length).toBeGreaterThan(0);

      const curatedCountBefore = curated.length;
      await maintainCommand({ vaultPath });
      const curatedAfter = globSync('**/inbox-*.md', {
        cwd: vaultPath,
        ignore: ['inbox/**', '.clawvault/**', 'ledger/**']
      });
      expect(curatedAfter.length).toBe(curatedCountBefore);
    } finally {
      logSpy.mockRestore();
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  it('runs a single worker when --worker is specified', async () => {
    process.env.CLAWVAULT_NO_LLM = '1';
    const vaultPath = makeVault();
    process.env.CLAWVAULT_PATH = vaultPath;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      addInboxItem(vaultPath, 'Decided to prioritize reliability fixes this sprint.', { title: 'Reliability priority' });
      const result = await maintainCommand({
        vaultPath,
        worker: 'curator'
      });
      expect(result.workers).toHaveLength(1);
      expect(result.workers[0].worker).toBe('curator');
      expect(fs.existsSync(path.join(vaultPath, '.clawvault', 'maintenance', 'surveyor-report.md'))).toBe(false);
    } finally {
      logSpy.mockRestore();
      fs.rmSync(vaultPath, { recursive: true, force: true });
    }
  });
});
