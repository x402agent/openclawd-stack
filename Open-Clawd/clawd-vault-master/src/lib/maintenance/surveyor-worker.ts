import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';
import { readInboxItems } from '../inbox.js';
import { buildHeuristicSurveyRecommendations } from './heuristics.js';
import { type MaintenanceLogger } from './log.js';
import { type WorkerLlmClient } from './llm.js';
import { type MaintenanceState, type WorkerExecutionContext, type WorkerRunResult } from './types.js';
import {
  hashList,
  SURVEYOR_SYSTEM_PROMPT,
  toRelative,
  writeFileIfChanged
} from './worker-utils.js';

interface VaultSurvey {
  totalDocs: number;
  linkedDocs: number;
  linkedRatio: number;
  categoryCounts: Record<string, number>;
}

function collectVaultSurvey(vaultPath: string): VaultSurvey {
  const docs = globSync('**/*.md', {
    cwd: path.resolve(vaultPath),
    nodir: true,
    absolute: true,
    ignore: ['.clawvault/**', 'ledger/**', 'node_modules/**']
  });
  const categoryCounts: Record<string, number> = {};
  let linkedDocs = 0;
  for (const filePath of docs) {
    const relativePath = toRelative(vaultPath, filePath);
    const category = relativePath.split('/')[0] || 'root';
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (/\[\[[^\]]+\]\]/.test(content)) {
      linkedDocs += 1;
    }
  }
  const linkedRatio = docs.length === 0 ? 0 : linkedDocs / docs.length;
  return {
    totalDocs: docs.length,
    linkedDocs,
    linkedRatio,
    categoryCounts
  };
}

function renderSurveyorReport(params: {
  now: Date;
  survey: VaultSurvey;
  inboxCount: number;
  recommendations: string[];
}): string {
  const counts = Object.entries(params.survey.categoryCounts)
    .sort((left, right) => right[1] - left[1])
    .map(([category, count]) => `- ${category}: ${count}`);

  return [
    `# Surveyor report (${params.now.toISOString().split('T')[0]})`,
    '',
    '## Vault health snapshot',
    `- Total markdown docs: ${params.survey.totalDocs}`,
    `- Linked docs: ${params.survey.linkedDocs}`,
    `- Link coverage ratio: ${(params.survey.linkedRatio * 100).toFixed(1)}%`,
    `- Inbox active captures: ${params.inboxCount}`,
    '',
    '## Category distribution',
    ...(counts.length > 0 ? counts : ['- No markdown categories found.']),
    '',
    '## Recommendations',
    ...params.recommendations.map((entry) => (entry.startsWith('- ') ? entry : `- ${entry}`))
  ].join('\n');
}

export async function runSurveyorWorker(
  ctx: WorkerExecutionContext,
  state: MaintenanceState,
  llm: WorkerLlmClient,
  logger: MaintenanceLogger
): Promise<WorkerRunResult> {
  const survey = collectVaultSurvey(ctx.vaultPath);
  const inboxCount = readInboxItems(ctx.vaultPath).length;
  const heuristicRecommendations = buildHeuristicSurveyRecommendations({
    inboxCount,
    linkedRatio: survey.linkedRatio,
    categoryCounts: survey.categoryCounts
  });

  let llmSuggestions = '';
  let usedLlm = false;
  if (llm.enabled) {
    llmSuggestions = await llm.complete(
      SURVEYOR_SYSTEM_PROMPT,
      [
        'Review this vault health summary and suggest 2-5 actionable improvements.',
        JSON.stringify({
          totalDocs: survey.totalDocs,
          linkedDocs: survey.linkedDocs,
          linkedRatio: survey.linkedRatio,
          inboxCount,
          categoryCounts: survey.categoryCounts
        }, null, 2)
      ].join('\n\n'),
      { tier: 'complex' }
    );
    usedLlm = llmSuggestions.trim().length > 0;
  }

  const recommendations = [...heuristicRecommendations];
  if (llmSuggestions.trim()) {
    const lines = llmSuggestions.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    recommendations.push(...lines);
  }

  const reportPath = path.join(ctx.vaultPath, '.clawvault', 'maintenance', 'surveyor-report.md');
  writeFileIfChanged(reportPath, renderSurveyorReport({
    now: ctx.now(),
    survey,
    inboxCount,
    recommendations
  }), ctx.dryRun);
  logger.append('surveyor', 'info', 'Updated surveyor report', {
    report: toRelative(ctx.vaultPath, reportPath),
    totalDocs: survey.totalDocs,
    inboxCount
  });

  const snapshotHash = hashList([
    String(survey.totalDocs),
    String(survey.linkedDocs),
    String(inboxCount),
    JSON.stringify(survey.categoryCounts)
  ]);
  state.workers.surveyor.processedHashes = [snapshotHash];
  state.workers.surveyor.updatedAt = ctx.now().toISOString();

  return {
    worker: 'surveyor',
    processed: 1,
    skipped: 0,
    actions: [`Updated ${toRelative(ctx.vaultPath, reportPath)}`],
    usedLlm,
    degradedMode: !usedLlm
  };
}
