import * as fs from 'fs';
import type { Command } from 'commander';
import { resolveVaultPath } from '../lib/config.js';
import { addInboxItem, type AddInboxItemResult } from '../lib/inbox.js';

export interface InboxAddCommandOptions {
  vaultPath?: string;
  content?: string;
  title?: string;
  source?: string;
  stdin?: boolean;
  readStdin?: () => string;
}

function resolveInboxContent(options: InboxAddCommandOptions): string {
  const inline = options.content?.trim();
  if (inline) {
    return inline;
  }

  if (options.stdin) {
    const reader = options.readStdin ?? (() => fs.readFileSync(0, 'utf-8'));
    const stdinContent = reader().trim();
    if (stdinContent) {
      return stdinContent;
    }
  }

  throw new Error('Inbox content is required. Provide <content> or pipe stdin.');
}

export async function inboxAddCommand(options: InboxAddCommandOptions): Promise<AddInboxItemResult> {
  const vaultPath = resolveVaultPath({ explicitPath: options.vaultPath });
  const content = resolveInboxContent(options);
  const result = addInboxItem(vaultPath, content, {
    title: options.title,
    source: options.source
  });
  console.log(`✓ Added inbox capture: ${result.id}`);
  console.log(`  Path: ${result.path}`);
  return result;
}

export function registerInboxCommand(program: Command): void {
  const inbox = program
    .command('inbox')
    .description('Manage raw captures in the vault inbox');

  inbox
    .command('add [content]')
    .description('Add content to inbox (or pipe stdin)')
    .option('-t, --title <title>', 'Optional capture title')
    .option('--source <source>', 'Source label (email, transcript, note, export, etc.)')
    .option('--stdin', 'Read content from stdin')
    .option('-v, --vault <path>', 'Vault path')
    .action(async (content: string | undefined, rawOptions: {
      title?: string;
      source?: string;
      stdin?: boolean;
      vault?: string;
    }) => {
      await inboxAddCommand({
        vaultPath: rawOptions.vault,
        content,
        title: rawOptions.title,
        source: rawOptions.source,
        stdin: rawOptions.stdin || !process.stdin.isTTY
      });
    });
}
