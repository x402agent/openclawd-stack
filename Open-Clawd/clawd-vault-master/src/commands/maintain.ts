import type { Command } from 'commander';
import { resolveVaultPath } from '../lib/config.js';
import { MaintenanceLogger } from '../lib/maintenance/log.js';
import { createWorkerLlmClient } from '../lib/maintenance/llm.js';
import { readMaintenanceState, writeMaintenanceState } from '../lib/maintenance/state.js';
import {
  MAINTENANCE_WORKERS,
  type MaintainRunResult,
  type MaintenanceWorkerName,
  type WorkerExecutionContext,
  type WorkerRunResult
} from '../lib/maintenance/types.js';
import {
  runCuratorWorker,
  runJanitorWorker,
  runDistillerWorker,
  runSurveyorWorker
} from '../lib/maintenance/workers.js';

export interface MaintainCommandOptions {
  vaultPath?: string;
  worker?: MaintenanceWorkerName;
  dryRun?: boolean;
  limit?: number;
  quiet?: boolean;
}

function parseWorker(value: string | undefined): MaintenanceWorkerName | null {
  if (!value) {
    return null;
  }
  return MAINTENANCE_WORKERS.includes(value as MaintenanceWorkerName)
    ? value as MaintenanceWorkerName
    : null;
}

function buildRunId(now: Date): string {
  return `maint-${now.toISOString().replace(/[-:.]/g, '').replace('T', 't')}`;
}

export async function maintainCommand(options: MaintainCommandOptions = {}): Promise<MaintainRunResult> {
  const resolvedWorker = parseWorker(options.worker);
  if (options.worker && !resolvedWorker) {
    throw new Error(
      `Unknown worker "${options.worker}". Expected one of: ${MAINTENANCE_WORKERS.join(', ')}`
    );
  }

  const vaultPath = resolveVaultPath({ explicitPath: options.vaultPath });
  const now = () => new Date();
  const started = now();
  const runId = buildRunId(started);
  const dryRun = options.dryRun ?? false;
  const maxItems = typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : undefined;

  const state = readMaintenanceState(vaultPath);
  const logger = new MaintenanceLogger(vaultPath, runId, dryRun);
  const llm = createWorkerLlmClient(vaultPath);
  const workerList = resolvedWorker ? [resolvedWorker] : [...MAINTENANCE_WORKERS];

  const ctx: WorkerExecutionContext = {
    vaultPath,
    runId,
    now,
    dryRun,
    maxItems
  };

  const workers: WorkerRunResult[] = [];
  for (const worker of workerList) {
    logger.append(worker, 'info', 'Worker started');
    let result: WorkerRunResult;
    if (worker === 'curator') {
      result = await runCuratorWorker(ctx, state, llm, logger);
    } else if (worker === 'janitor') {
      result = await runJanitorWorker(ctx, state, llm, logger);
    } else if (worker === 'distiller') {
      result = await runDistillerWorker(ctx, state, llm, logger);
    } else {
      result = await runSurveyorWorker(ctx, state, llm, logger);
    }
    workers.push(result);
    logger.append(worker, 'info', 'Worker completed', {
      processed: result.processed,
      skipped: result.skipped,
      degradedMode: result.degradedMode
    });
  }

  writeMaintenanceState(vaultPath, state);

  const finishedAt = now().toISOString();
  const summary: MaintainRunResult = {
    runId,
    vaultPath,
    startedAt: started.toISOString(),
    finishedAt,
    logPath: logger.path,
    workers
  };

  if (!options.quiet) {
    console.log(`Maintenance run: ${runId}`);
    for (const worker of workers) {
      const mode = worker.degradedMode ? 'heuristic' : 'llm';
      console.log(
        `- ${worker.worker}: processed=${worker.processed}, skipped=${worker.skipped}, mode=${mode}`
      );
    }
    console.log(`Maintenance log: ${summary.logPath}`);
  }

  return summary;
}

export function registerMaintainCommand(program: Command): void {
  program
    .command('maintain')
    .description('Run inbox maintenance workers (curator, janitor, distiller, surveyor)')
    .option('--worker <name>', `Run a single worker: ${MAINTENANCE_WORKERS.join(', ')}`)
    .option('--limit <n>', 'Limit inbox items processed per worker', (value) => Number.parseInt(value, 10))
    .option('--dry-run', 'Preview actions without writing files')
    .option('-v, --vault <path>', 'Vault path')
    .action(async (rawOptions: {
      worker?: string;
      limit?: number;
      dryRun?: boolean;
      vault?: string;
    }) => {
      await maintainCommand({
        vaultPath: rawOptions.vault,
        worker: rawOptions.worker as MaintenanceWorkerName | undefined,
        dryRun: rawOptions.dryRun,
        limit: rawOptions.limit
      });
    });
}
