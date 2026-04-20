export const MAINTENANCE_WORKERS = ['curator', 'janitor', 'distiller', 'surveyor'] as const;

export type MaintenanceWorkerName = (typeof MAINTENANCE_WORKERS)[number];

export interface WorkerRunResult {
  worker: MaintenanceWorkerName;
  processed: number;
  skipped: number;
  actions: string[];
  usedLlm: boolean;
  degradedMode: boolean;
}

export interface MaintainRunResult {
  runId: string;
  vaultPath: string;
  startedAt: string;
  finishedAt: string;
  logPath: string;
  workers: WorkerRunResult[];
}

export interface WorkerExecutionContext {
  vaultPath: string;
  runId: string;
  now: () => Date;
  dryRun: boolean;
  maxItems?: number;
}

export interface MaintenanceState {
  version: 1;
  workers: Record<MaintenanceWorkerName, { processedHashes: string[]; updatedAt?: string }>;
}
