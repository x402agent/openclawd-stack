import * as fs from 'fs';
import * as path from 'path';
import {
  MAINTENANCE_WORKERS,
  type MaintenanceState
} from './types.js';

const STATE_FILE = 'maintenance-state.json';

function defaultState(): MaintenanceState {
  return {
    version: 1,
    workers: {
      curator: { processedHashes: [] },
      janitor: { processedHashes: [] },
      distiller: { processedHashes: [] },
      surveyor: { processedHashes: [] }
    }
  };
}

function statePath(vaultPath: string): string {
  return path.join(path.resolve(vaultPath), '.clawvault', STATE_FILE);
}

export function readMaintenanceState(vaultPath: string): MaintenanceState {
  const filePath = statePath(vaultPath);
  if (!fs.existsSync(filePath)) {
    return defaultState();
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return defaultState();
    }
    const record = raw as Partial<MaintenanceState>;
    const next = defaultState();
    for (const worker of MAINTENANCE_WORKERS) {
      const candidate = record.workers?.[worker];
      const hashes = Array.isArray(candidate?.processedHashes)
        ? candidate!.processedHashes.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : [];
      next.workers[worker] = {
        processedHashes: hashes,
        updatedAt: typeof candidate?.updatedAt === 'string' ? candidate.updatedAt : undefined
      };
    }
    return next;
  } catch {
    return defaultState();
  }
}

export function writeMaintenanceState(vaultPath: string, state: MaintenanceState): void {
  const filePath = statePath(vaultPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}
