import * as path from 'path';
import matter from 'gray-matter';
import { readInboxItems, type InboxItem } from '../inbox.js';
import { extractHeuristicInsights } from './heuristics.js';
import { type MaintenanceLogger } from './log.js';
import { type WorkerLlmClient } from './llm.js';
import { type MaintenanceState, type WorkerExecutionContext, type WorkerRunResult } from './types.js';
import {
  buildDistillerLlmPrompt,
  DISTILLER_SYSTEM_PROMPT,
  parseDistillerInsights,
  toRelative,
  wordsCount,
  writeFileIfChanged
} from './worker-utils.js';

function renderDistilledContent(
  item: InboxItem,
  now: Date,
  sectionTitle: string,
  entries: string[]
): string {
  const body = `## ${sectionTitle}\n${entries.map((line) => `- ${line}`).join('\n')}\n\n---\nDistilled from \`${item.relativePath}\`.\n`;
  return matter.stringify(body, {
    title: `${sectionTitle} from ${item.title}`,
    date: now.toISOString().split('T')[0],
    source: 'distiller',
    inboxHash: item.hash,
    inboxPath: item.relativePath
  });
}

function writeDistilledEntries(
  ctx: WorkerExecutionContext,
  item: InboxItem,
  category: 'facts' | 'decisions' | 'lessons',
  sectionTitle: string,
  entries: string[],
  logger: MaintenanceLogger,
  actions: string[]
): void {
  if (entries.length === 0) {
    return;
  }
  const filePath = path.join(ctx.vaultPath, category, `distilled-${item.hash.slice(0, 12)}.md`);
  const wrote = writeFileIfChanged(
    filePath,
    renderDistilledContent(item, ctx.now(), sectionTitle, entries),
    ctx.dryRun
  );
  actions.push(`${wrote ? 'Updated' : 'Kept'} ${toRelative(ctx.vaultPath, filePath)}`);
  logger.append('distiller', 'info', 'Updated distilled output', {
    source: item.relativePath,
    category,
    target: toRelative(ctx.vaultPath, filePath),
    entries: entries.length,
    wrote
  });
}

export async function runDistillerWorker(
  ctx: WorkerExecutionContext,
  state: MaintenanceState,
  llm: WorkerLlmClient,
  logger: MaintenanceLogger
): Promise<WorkerRunResult> {
  const items = readInboxItems(ctx.vaultPath, { limit: ctx.maxItems });
  const processed = new Set(state.workers.distiller.processedHashes);
  const pending = items.filter((item) => !processed.has(item.hash));
  const longForm = pending.filter((item) => wordsCount(item.content) >= 80);
  let llmInsights = new Map<string, { facts: string[]; decisions: string[]; lessons: string[] }>();
  let usedLlm = false;

  if (llm.enabled && longForm.length > 0) {
    const response = await llm.complete(
      DISTILLER_SYSTEM_PROMPT,
      buildDistillerLlmPrompt(longForm),
      { tier: 'complex' }
    );
    if (response.trim()) {
      llmInsights = parseDistillerInsights(response);
      usedLlm = llmInsights.size > 0;
    }
  }

  const actions: string[] = [];
  let processedCount = 0;
  for (const item of longForm) {
    const insights = llmInsights.get(item.hash) ?? extractHeuristicInsights(item.content);
    writeDistilledEntries(ctx, item, 'facts', 'Facts', insights.facts, logger, actions);
    writeDistilledEntries(ctx, item, 'decisions', 'Decisions', insights.decisions, logger, actions);
    writeDistilledEntries(ctx, item, 'lessons', 'Lessons', insights.lessons, logger, actions);
    processed.add(item.hash);
    processedCount += 1;
  }

  for (const item of pending) {
    if (!processed.has(item.hash)) {
      processed.add(item.hash);
      logger.append('distiller', 'info', 'Skipped short-form inbox item', {
        source: item.relativePath,
        words: wordsCount(item.content)
      });
    }
  }

  state.workers.distiller.processedHashes = [...processed];
  state.workers.distiller.updatedAt = ctx.now().toISOString();

  return {
    worker: 'distiller',
    processed: processedCount,
    skipped: pending.length - processedCount + (items.length - pending.length),
    actions,
    usedLlm,
    degradedMode: !usedLlm
  };
}
