import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import matter from 'gray-matter';
import { Command } from 'commander';
import { createVault, type ClawVault } from '../lib/vault.js';
import { patchCommand, registerPatchCommand } from './patch.js';

const createdTempDirs: string[] = [];

async function makeVault(): Promise<{ vaultPath: string; vault: ClawVault }> {
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'clawvault-patch-cmd-'));
  createdTempDirs.push(vaultPath);
  const vault = await createVault(vaultPath, { name: 'patch-test' }, { skipGraph: true });
  return { vaultPath, vault };
}

function readDoc(vaultPath: string, id: string): string {
  const filePath = path.join(vaultPath, `${id}.md`);
  return fs.readFileSync(filePath, 'utf-8');
}

afterEach(() => {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('patchCommand', () => {
  it('appends content while preserving frontmatter and indexed docs', async () => {
    const { vaultPath, vault } = await makeVault();
    const target = await vault.store({
      category: 'decisions',
      title: 'patch-target',
      content: 'Line A',
      frontmatter: { owner: 'ops' }
    });
    const untouched = await vault.store({
      category: 'inbox',
      title: 'untouched',
      content: 'Do not change me'
    });

    await patchCommand(target.id, {
      vaultPath,
      append: 'Line B'
    });

    const raw = readDoc(vaultPath, target.id);
    const parsed = matter(raw);
    expect(parsed.data.owner).toBe('ops');
    expect(parsed.content).toContain('Line A');
    expect(parsed.content.trimEnd()).toMatch(/Line A\nLine B$/);

    const indexPath = path.join(vaultPath, '.clawvault-index.json');
    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      documents: Array<{ id: string }>;
    };
    const indexedIds = indexData.documents.map((doc) => doc.id);
    expect(indexedIds).toContain(target.id);
    expect(indexedIds).toContain(untouched.id);
  });

  it('replaces all occurrences for --replace/--with mode', async () => {
    const { vaultPath, vault } = await makeVault();
    const target = await vault.store({
      category: 'decisions',
      title: 'replace-target',
      content: 'old value and old value'
    });

    await patchCommand(target.id, {
      vaultPath,
      replace: 'old',
      with: 'new'
    });

    const raw = readDoc(vaultPath, target.id);
    const parsed = matter(raw);
    expect(parsed.content).toContain('new value and new value');
    expect(parsed.content).not.toContain('old value');
  });

  it('upserts an existing markdown section body', async () => {
    const { vaultPath, vault } = await makeVault();
    const target = await vault.store({
      category: 'projects',
      title: 'section-existing',
      content: [
        'Intro',
        '',
        '## Plan',
        'Old plan',
        '',
        '## Next',
        'Keep this'
      ].join('\n')
    });

    await patchCommand(target.id, {
      vaultPath,
      section: '## Plan',
      content: 'Updated plan'
    });

    const raw = readDoc(vaultPath, target.id);
    const parsed = matter(raw);
    expect(parsed.content).toContain('## Plan\nUpdated plan');
    expect(parsed.content).toContain('## Next\nKeep this');
    const headingMatches = parsed.content.match(/^## Plan$/gm) ?? [];
    expect(headingMatches).toHaveLength(1);
  });

  it('upserts a missing markdown section by appending it', async () => {
    const { vaultPath, vault } = await makeVault();
    const target = await vault.store({
      category: 'projects',
      title: 'section-missing',
      content: 'Intro only'
    });

    await patchCommand(target.id, {
      vaultPath,
      section: '## Notes',
      content: 'Added body'
    });

    const raw = readDoc(vaultPath, target.id);
    const parsed = matter(raw);
    expect(parsed.content).toContain('Intro only');
    expect(parsed.content.trimEnd()).toMatch(/## Notes\nAdded body$/);
  });
});

describe('registerPatchCommand', () => {
  it('registers patch command and applies append mode', async () => {
    const { vaultPath, vault } = await makeVault();
    const target = await vault.store({
      category: 'inbox',
      title: 'cli-append',
      content: 'start'
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const program = new Command();
    registerPatchCommand(program);

    await program.parseAsync(
      ['patch', target.id, '--append', 'finish', '--vault', vaultPath],
      { from: 'user' }
    );

    const raw = readDoc(vaultPath, target.id);
    const parsed = matter(raw);
    expect(parsed.content.trimEnd()).toMatch(/start\nfinish$/);
    expect(logSpy).toHaveBeenCalledWith(`Patched: ${target.id}`);
    logSpy.mockRestore();
  });

  it('throws when more than one patch mode is selected', async () => {
    const program = new Command();
    registerPatchCommand(program);

    await expect(
      program.parseAsync(
        ['patch', 'decisions/test', '--append', 'one', '--replace', 'one', '--with', 'two'],
        { from: 'user' }
      )
    ).rejects.toThrow(
      'Select exactly one patch mode: --append, --replace with --with, or --section with --content.'
    );
  });
});
