import type { Command } from 'commander';
import { ClawVault } from '../lib/vault.js';
import { resolveVaultPath } from '../lib/config.js';
import type { Document, PatchOptions } from '../types.js';

export interface PatchCommandOptions {
  vaultPath?: string;
  append?: string;
  replace?: string;
  with?: string;
  section?: string;
  content?: string;
}

function normalizeSectionHeading(heading: string): string {
  const trimmed = heading.trim();
  if (!trimmed) {
    throw new Error('Section heading cannot be empty.');
  }
  if (trimmed.startsWith('#')) {
    return trimmed;
  }
  return `## ${trimmed}`;
}

function buildSectionAppendText(heading: string, content: string): string {
  const headingLine = normalizeSectionHeading(heading);
  return `\n${headingLine}\n${content}`;
}

function isSectionNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Section not found:');
}

function resolvePatchOptions(idOrPath: string, options: PatchCommandOptions): PatchOptions {
  const appendSelected = typeof options.append === 'string';
  const replaceSelected = typeof options.replace === 'string' || typeof options.with === 'string';
  const sectionSelected = typeof options.section === 'string' || typeof options.content === 'string';
  const selectedModeCount = [appendSelected, replaceSelected, sectionSelected]
    .filter(Boolean)
    .length;

  if (selectedModeCount !== 1) {
    throw new Error(
      'Select exactly one patch mode: --append, --replace with --with, or --section with --content.'
    );
  }

  if (appendSelected) {
    return {
      idOrPath,
      mode: 'append',
      append: options.append
    };
  }

  if (replaceSelected) {
    if (typeof options.replace !== 'string' || typeof options.with !== 'string') {
      throw new Error('Replace mode requires both --replace and --with.');
    }
    return {
      idOrPath,
      mode: 'replace',
      replace: options.replace,
      with: options.with
    };
  }

  if (typeof options.section !== 'string' || typeof options.content !== 'string') {
    throw new Error('Section mode requires both --section and --content.');
  }

  return {
    idOrPath,
    mode: 'content',
    section: options.section,
    content: options.content
  };
}

async function runSectionUpsert(
  vault: ClawVault,
  idOrPath: string,
  section: string,
  content: string
): Promise<Document> {
  try {
    return await vault.patch({
      idOrPath,
      mode: 'content',
      section,
      content
    });
  } catch (error: unknown) {
    if (!isSectionNotFoundError(error)) {
      throw error;
    }

    return vault.patch({
      idOrPath,
      mode: 'append',
      append: buildSectionAppendText(section, content)
    });
  }
}

export async function patchCommand(idOrPath: string, options: PatchCommandOptions): Promise<Document> {
  const patchOptions = resolvePatchOptions(idOrPath, options);
  const vaultPath = resolveVaultPath({ explicitPath: options.vaultPath });
  const vault = new ClawVault(vaultPath);
  await vault.load();

  if (patchOptions.mode === 'content') {
    return runSectionUpsert(
      vault,
      patchOptions.idOrPath,
      patchOptions.section as string,
      patchOptions.content as string
    );
  }
  return vault.patch(patchOptions);
}

export function registerPatchCommand(program: Command): void {
  program
    .command('patch <path>')
    .description('Patch an existing memory document')
    .option('--append <content>', 'Append text to the end of a document')
    .option('--replace <old>', 'Text to find for replacement')
    .option('--with <new>', 'Replacement text used with --replace')
    .option('--section <heading>', 'Markdown heading to upsert')
    .option('--content <body>', 'Section body content used with --section')
    .option('-v, --vault <path>', 'Vault path')
    .action(async (
      pathArg: string,
      rawOptions: {
        append?: string;
        replace?: string;
        with?: string;
        section?: string;
        content?: string;
        vault?: string;
      }
    ) => {
      const doc = await patchCommand(pathArg, {
        vaultPath: rawOptions.vault,
        append: rawOptions.append,
        replace: rawOptions.replace,
        with: rawOptions.with,
        section: rawOptions.section,
        content: rawOptions.content
      });
      console.log(`Patched: ${doc.id}`);
    });
}
