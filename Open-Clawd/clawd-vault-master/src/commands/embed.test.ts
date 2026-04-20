import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const {
  hasQmdMock,
  recoverQmdEmbeddingIfNeededMock,
  runCrashSafeQmdEmbedMock
} = vi.hoisted(() => ({
  hasQmdMock: vi.fn(),
  recoverQmdEmbeddingIfNeededMock: vi.fn(),
  runCrashSafeQmdEmbedMock: vi.fn()
}));

vi.mock('../lib/search.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/search.js')>('../lib/search.js');
  return {
    ...actual,
    hasQmd: hasQmdMock
  };
});

vi.mock('../lib/qmd-embedding-recovery.js', () => ({
  recoverQmdEmbeddingIfNeeded: recoverQmdEmbeddingIfNeededMock,
  runCrashSafeQmdEmbed: runCrashSafeQmdEmbedMock
}));

vi.mock('../lib/qmd-collections.js', () => ({
  findCollectionByRoot: vi.fn().mockReturnValue(undefined),
  collectionExists: vi.fn().mockReturnValue(true),
  listQmdCollections: vi.fn().mockReturnValue([]),
  getFirstCollection: vi.fn().mockReturnValue(undefined)
}));

import { embedCommand } from './embed.js';
import { QmdUnavailableError } from '../lib/search.js';

const createdTempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.clearAllMocks();
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('embed command', () => {
  it('uses vault qmd collection from config', async () => {
    hasQmdMock.mockReturnValue(true);
    recoverQmdEmbeddingIfNeededMock.mockReturnValue({ recovered: false });
    const vaultPath = makeTempDir('clawvault-embed-');
    const rootPath = path.join(vaultPath, 'notes-root');
    fs.mkdirSync(rootPath, { recursive: true });
    fs.writeFileSync(
      path.join(vaultPath, '.clawvault.json'),
      JSON.stringify({
        name: 'memory',
        version: '1.0.0',
        created: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        categories: [],
        documentCount: 0,
        qmdCollection: 'vault-collection',
        qmdRoot: './notes-root'
      }, null, 2)
    );

    const result = await embedCommand({ vaultPath, quiet: true });
    expect(recoverQmdEmbeddingIfNeededMock).toHaveBeenCalledWith({
      vaultPath: path.resolve(vaultPath),
      collection: 'vault-collection',
      rootPath,
      mode: 'marker-or-empty',
      onLog: undefined
    });
    expect(runCrashSafeQmdEmbedMock).toHaveBeenCalledWith({
      vaultPath: path.resolve(vaultPath),
      collection: 'vault-collection',
      rootPath
    });
    expect(result.qmdCollection).toBe('vault-collection');
    expect(result.qmdRoot).toBe(rootPath);
  });

  it('throws when qmd is unavailable', async () => {
    hasQmdMock.mockReturnValue(false);
    await expect(embedCommand({ vaultPath: '/tmp/memory', quiet: true })).rejects.toBeInstanceOf(QmdUnavailableError);
    expect(runCrashSafeQmdEmbedMock).not.toHaveBeenCalled();
  });
});
