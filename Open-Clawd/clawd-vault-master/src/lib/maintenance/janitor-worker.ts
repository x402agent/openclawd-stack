import * as path from 'path';
import matter from 'gray-matter';
import { readInboxItems, type InboxItem } from '../inbox.js';
import { normalizeForDedup, similarityScore } from './heuristics.js';
import { type MaintenanceLogger } from './log.js';
import { type WorkerLlmClient } from './llm.js';
import { type MaintenanceState, type WorkerExecutionContext, type WorkerRunResult } from './types.js';
import {
  hashList,
  JANITOR_SYSTEM_PROMPT,
  moveToArchive,
  toRelative,
  truncate,
  writeFileIfChanged
} from './worker-utils.js';

interface JanitorCluster {
  id: string;
  items: InboxItem[];
}

function buildRelatedClusters(items: InboxItem[]): JanitorCluster[] {
  const clusters: JanitorCluster[] = [];
  const used = new Set<string>();

  for (let index = 0; index < items.length; index += 1) {
    const seed = items[index];
    if (used.has(seed.hash)) {
      continue;
    }
    const clusterItems = [seed];
    for (let cursor = index + 1; cursor < items.length; cursor += 1) {
      const candidate = items[cursor];
      if (used.has(candidate.hash)) {
        continue;
      }
      const score = similarityScore(seed.content, candidate.content);
      if (score >= 0.55) {
        clusterItems.push(candidate);
      }
    }
    if (clusterItems.length > 1) {
      for (const item of clusterItems) {
        used.add(item.hash);
      }
      const clusterId = hashList(clusterItems.map((item) => item.hash).sort()).slice(0, 12);
      clusters.push({ id: clusterId, items: clusterItems.sort((left, right) => left.relativePath.localeCompare(right.relativePath)) });
    }
  }

  return clusters;
}

function renderJanitorMergedCluster(cluster: JanitorCluster, now: Date): string {
  const lines = cluster.items.map((item) => `- **${item.title}** (\`${item.relativePath}\`): ${truncate(item.content, 180)}`);
  return matter.stringify(
    `## Related captures\n${lines.join('\n')}\n`,
    {
      title: `Merged inbox cluster ${cluster.id}`,
      date: now.toISOString().split('T')[0],
      type: 'inbox-merge',
      sources: cluster.items.map((item) => item.relativePath)
    }
  );
}

function renderJanitorReport(params: {
  now: Date;
  duplicatesMoved: number;
  staleArchived: number;
  mergedClusters: number;
  llmRecommendation: string;
}): string {
  const recommendations = params.llmRecommendation.trim()
    ? params.llmRecommendation.trim()
    : '- Keep capture titles descriptive to improve curator routing quality.';
  return [
    `# Janitor report (${params.now.toISOString().split('T')[0]})`,
    '',
    `- Duplicates archived: ${params.duplicatesMoved}`,
    `- Stale items archived: ${params.staleArchived}`,
    `- Merged related clusters: ${params.mergedClusters}`,
    '',
    '## Recommendations',
    recommendations
  ].join('\n');
}

export async function runJanitorWorker(
  ctx: WorkerExecutionContext,
  state: MaintenanceState,
  llm: WorkerLlmClient,
  logger: MaintenanceLogger
): Promise<WorkerRunResult> {
  const items = readInboxItems(ctx.vaultPath, { limit: ctx.maxItems });
  const byNormalized = new Map<string, InboxItem[]>();
  for (const item of items) {
    const key = normalizeForDedup(item.content);
    if (!key) {
      continue;
    }
    const bucket = byNormalized.get(key) ?? [];
    bucket.push(item);
    byNormalized.set(key, bucket);
  }

  let duplicatesMoved = 0;
  const actions: string[] = [];
  for (const [, grouped] of byNormalized) {
    if (grouped.length < 2) {
      continue;
    }
    const sorted = [...grouped].sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime());
    for (const duplicate of sorted.slice(1)) {
      const archiveDir = path.join(ctx.vaultPath, 'inbox', 'archive', 'deduped');
      const moved = moveToArchive(duplicate.path, archiveDir, ctx.dryRun);
      duplicatesMoved += 1;
      actions.push(`Archived duplicate ${duplicate.relativePath} -> ${toRelative(ctx.vaultPath, moved.destinationPath)}`);
      logger.append('janitor', 'info', 'Archived duplicate inbox capture', {
        source: duplicate.relativePath,
        target: toRelative(ctx.vaultPath, moved.destinationPath)
      });
    }
  }

  const refreshItems = readInboxItems(ctx.vaultPath, { limit: ctx.maxItems });
  let staleArchived = 0;
  const staleCutoffMs = ctx.now().getTime() - (30 * 24 * 60 * 60 * 1000);
  for (const item of refreshItems) {
    if (item.capturedAt.getTime() >= staleCutoffMs) {
      continue;
    }
    const archiveDir = path.join(ctx.vaultPath, 'inbox', 'archive', 'stale');
    const moved = moveToArchive(item.path, archiveDir, ctx.dryRun);
    staleArchived += 1;
    actions.push(`Archived stale ${item.relativePath} -> ${toRelative(ctx.vaultPath, moved.destinationPath)}`);
    logger.append('janitor', 'info', 'Archived stale inbox capture', {
      source: item.relativePath,
      target: toRelative(ctx.vaultPath, moved.destinationPath)
    });
  }

  const postArchiveItems = readInboxItems(ctx.vaultPath, { limit: ctx.maxItems });
  const clusters = buildRelatedClusters(postArchiveItems);
  for (const cluster of clusters) {
    const mergedPath = path.join(ctx.vaultPath, 'inbox', 'merged', `merged-${cluster.id}.md`);
    const wrote = writeFileIfChanged(mergedPath, renderJanitorMergedCluster(cluster, ctx.now()), ctx.dryRun);
    actions.push(`${wrote ? 'Updated' : 'Kept'} merged cluster ${toRelative(ctx.vaultPath, mergedPath)}`);
    logger.append('janitor', 'info', 'Updated merged inbox cluster', {
      clusterId: cluster.id,
      file: toRelative(ctx.vaultPath, mergedPath),
      items: cluster.items.map((item) => item.relativePath)
    });
  }

  let llmRecommendation = '';
  let usedLlm = false;
  if (llm.enabled) {
    llmRecommendation = await llm.complete(
      JANITOR_SYSTEM_PROMPT,
      [
        'Provide 2-4 concise hygiene recommendations.',
        `duplicatesMoved=${duplicatesMoved}`,
        `staleArchived=${staleArchived}`,
        `mergedClusters=${clusters.length}`
      ].join('\n'),
      { tier: 'background' }
    );
    usedLlm = llmRecommendation.trim().length > 0;
  }

  const reportPath = path.join(ctx.vaultPath, '.clawvault', 'maintenance', 'janitor-report.md');
  writeFileIfChanged(reportPath, renderJanitorReport({
    now: ctx.now(),
    duplicatesMoved,
    staleArchived,
    mergedClusters: clusters.length,
    llmRecommendation
  }), ctx.dryRun);
  logger.append('janitor', 'info', 'Updated janitor report', {
    report: toRelative(ctx.vaultPath, reportPath),
    duplicatesMoved,
    staleArchived,
    mergedClusters: clusters.length
  });

  state.workers.janitor.updatedAt = ctx.now().toISOString();

  return {
    worker: 'janitor',
    processed: duplicatesMoved + staleArchived + clusters.length,
    skipped: 0,
    actions,
    usedLlm,
    degradedMode: !usedLlm
  };
}
