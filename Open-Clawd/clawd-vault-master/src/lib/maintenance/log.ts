import * as fs from 'fs';
import * as path from 'path';
import type { MaintenanceWorkerName } from './types.js';

export interface MaintenanceLogEvent {
  ts: string;
  runId: string;
  worker: MaintenanceWorkerName;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

export class MaintenanceLogger {
  private readonly filePath: string;
  private readonly runId: string;
  private readonly dryRun: boolean;

  constructor(vaultPath: string, runId: string, dryRun: boolean) {
    this.filePath = path.join(path.resolve(vaultPath), '.clawvault', 'maintenance-log.jsonl');
    this.runId = runId;
    this.dryRun = dryRun;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  get path(): string {
    return this.filePath;
  }

  append(
    worker: MaintenanceWorkerName,
    level: 'info' | 'warn' | 'error',
    message: string,
    data?: Record<string, unknown>
  ): void {
    const event: MaintenanceLogEvent = {
      ts: new Date().toISOString(),
      runId: this.runId,
      worker,
      level,
      message
    };
    if (data && Object.keys(data).length > 0) {
      event.data = data;
    }
    if (this.dryRun) {
      event.data = { ...(event.data ?? {}), dryRun: true };
    }
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf-8');
  }
}
