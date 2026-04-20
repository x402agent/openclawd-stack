import type { Command } from 'commander';
import { resolveVaultPath } from '../lib/config.js';
import { hasQmd, QmdUnavailableError } from '../lib/search.js';
import { loadVaultQmdConfig } from '../lib/vault-qmd-config.js';
import {
  recoverQmdEmbeddingIfNeeded,
  runCrashSafeQmdEmbed
} from '../lib/qmd-embedding-recovery.js';

export interface EmbedCommandOptions {
  vaultPath?: string;
  quiet?: boolean;
}

export interface EmbedCommandResult {
  vaultPath: string;
  qmdCollection: string;
  qmdRoot: string;
  startedAt: string;
  finishedAt: string;
}

export async function embedCommand(options: EmbedCommandOptions = {}): Promise<EmbedCommandResult> {
  if (!hasQmd()) {
    throw new QmdUnavailableError();
  }

  const vaultPath = resolveVaultPath({ explicitPath: options.vaultPath });
  const qmdConfig = loadVaultQmdConfig(vaultPath);
  const startedAt = new Date().toISOString();

  const recovery = recoverQmdEmbeddingIfNeeded({
    vaultPath,
    collection: qmdConfig.qmdCollection,
    rootPath: qmdConfig.qmdRoot,
    mode: 'marker-or-empty',
    onLog: options.quiet ? undefined : (message) => console.log(message)
  });

  if (!options.quiet && recovery.recovered) {
    const reasonLabel = recovery.reason === 'interrupted_wal' ? 'interrupted run' : 'empty vector state';
    console.log(`✓ Automatic qmd recovery completed (${reasonLabel}).`);
  }

  if (!options.quiet) {
    console.log(
      `Embedding pending documents for collection "${qmdConfig.qmdCollection}" (root: ${qmdConfig.qmdRoot})...`
    );
  }

  runCrashSafeQmdEmbed({
    vaultPath,
    collection: qmdConfig.qmdCollection,
    rootPath: qmdConfig.qmdRoot
  });

  const finishedAt = new Date().toISOString();
  if (!options.quiet) {
    console.log(`✓ Embedding complete for "${qmdConfig.qmdCollection}"`);
  }

  return {
    vaultPath,
    qmdCollection: qmdConfig.qmdCollection,
    qmdRoot: qmdConfig.qmdRoot,
    startedAt,
    finishedAt
  };
}

export function registerEmbedCommand(program: Command): void {
  program
    .command('embed')
    .description('Run qmd embedding for pending vault documents')
    .option('-v, --vault <path>', 'Vault path')
    .action(async (rawOptions: { vault?: string }) => {
      await embedCommand({
        vaultPath: rawOptions.vault
      });
    });
}
