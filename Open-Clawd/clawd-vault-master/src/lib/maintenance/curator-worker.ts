import * as path from 'path';
import matter from 'gray-matter';
import { readInboxItems, type InboxItem } from '../inbox.js';
import { classifyInboxItemHeuristic } from './heuristics.js';
import { type MaintenanceLogger } from './log.js';
import { type WorkerLlmClient } from './llm.js';
import { type MaintenanceState, type WorkerExecutionContext, type WorkerRunResult } from './types.js';
import {
  buildCuratorLlmPrompt,
  CURATOR_SYSTEM_PROMPT,
  parseCuratorRoutes,
  toRelative,
  writeFileIfChanged
} from './worker-utils.js';

function renderCuratedContent(item: InboxItem, now: Date, category: string): string {
  const body = `${item.content.trim()}\n\n---\nCurated from \`${item.relativePath}\` by background curator.\n`;
  return matter.stringify(body, {
    title: item.title,
    date: now.toISOString().split('T')[0],
    source: 'inbox',
    inboxHash: item.hash,
    inboxPath: item.relativePath,
    curatedBy: 'curator',
    curatedCategory: category
  });
}

export async function runCuratorWorker(
  ctx: WorkerExecutionContext,
  state: MaintenanceState,
  llm: WorkerLlmClient,
  logger: MaintenanceLogger
): Promise<WorkerRunResult> {
  const items = readInboxItems(ctx.vaultPath, { limit: ctx.maxItems });
  const processed = new Set(state.workers.curator.processedHashes);
  const pending = items.filter((item) => !processed.has(item.hash));
  let usedLlm = false;
  let llmRoutes = new Map<string, string>();

  if (pending.length > 0 && llm.enabled) {
    const response = await llm.complete(
      CURATOR_SYSTEM_PROMPT,
      buildCuratorLlmPrompt(pending),
      { tier: 'background' }
    );
    if (response.trim()) {
      llmRoutes = parseCuratorRoutes(response);
      usedLlm = llmRoutes.size > 0;
    }
  }

  const actions: string[] = [];
  let processedCount = 0;
  for (const item of pending) {
    const category = llmRoutes.get(item.hash) ?? classifyInboxItemHeuristic(item);
    const now = ctx.now();
    const targetPath = path.join(ctx.vaultPath, category, `inbox-${item.hash.slice(0, 12)}.md`);
    const wrote = writeFileIfChanged(targetPath, renderCuratedContent(item, now, category), ctx.dryRun);
    processed.add(item.hash);
    processedCount += 1;
    const action = `${item.relativePath} -> ${toRelative(ctx.vaultPath, targetPath)}${wrote ? '' : ' (unchanged)'}`;
    actions.push(action);
    logger.append('curator', 'info', 'Curated inbox item', {
      source: item.relativePath,
      category,
      target: toRelative(ctx.vaultPath, targetPath),
      wrote
    });
  }

  state.workers.curator.processedHashes = [...processed];
  state.workers.curator.updatedAt = ctx.now().toISOString();

  return {
    worker: 'curator',
    processed: processedCount,
    skipped: items.length - pending.length,
    actions,
    usedLlm,
    degradedMode: !usedLlm
  };
}
