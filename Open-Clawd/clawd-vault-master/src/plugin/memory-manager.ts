import * as fs from "fs";
import * as path from "path";
import { ClawVault } from "../lib/vault.js";
import { hasQmd } from "../lib/search.js";
import type { SearchResult } from "../types.js";
import {
  extractAgentIdFromSessionKey,
  type ClawVaultPluginConfig
} from "./config.js";
import {
  resolveVaultPathForAgent,
  sanitizePromptForContext
} from "./clawvault-cli.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult
} from "./memory-types.js";

const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.2;

export interface ClawVaultMemoryManagerOptions {
  pluginConfig: ClawVaultPluginConfig;
  workspaceDir?: string;
  defaultAgentId?: string;
  logger?: {
    debug?: (message: string) => void;
    warn: (message: string) => void;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRelPath(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
}

function estimateLineRange(content: string, snippet: string): { startLine: number; endLine: number } {
  const cleanedSnippet = snippet.replace(/\s+/g, " ").trim();
  if (!cleanedSnippet) {
    return { startLine: 1, endLine: 1 };
  }
  const normalizedContent = content.replace(/\s+/g, " ");
  const index = normalizedContent.toLowerCase().indexOf(cleanedSnippet.toLowerCase());
  if (index < 0) {
    return { startLine: 1, endLine: Math.max(1, cleanedSnippet.split(/\r?\n/).length) };
  }

  const upToIndex = normalizedContent.slice(0, index);
  const startLine = upToIndex.split(/\r?\n/).length;
  const endLine = startLine + Math.max(1, cleanedSnippet.split(/\r?\n/).length) - 1;
  return { startLine, endLine };
}

function mapSearchResult(vaultPath: string, result: SearchResult): MemorySearchResult {
  const relPath = normalizeRelPath(path.relative(vaultPath, result.document.path));
  const { startLine, endLine } = estimateLineRange(result.document.content, result.snippet);
  const source = relPath === "MEMORY.md" || relPath.startsWith("memory/")
    ? "memory"
    : "sessions";

  return {
    path: relPath || path.basename(result.document.path),
    startLine,
    endLine,
    score: result.score,
    snippet: result.snippet,
    source,
    citation: `${relPath || path.basename(result.document.path)}#L${startLine}-L${endLine}`
  };
}

function countMarkdownFiles(root: string): number {
  if (!fs.existsSync(root)) return 0;

  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        count += 1;
      }
    }
  }
  return count;
}

function toSafeFilePath(vaultPath: string, relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  const mapped = normalized.startsWith("qmd/")
    ? normalized.split("/").slice(2).join("/")
    : normalized;

  if (!mapped || mapped.includes("..")) {
    throw new Error("Invalid memory path");
  }

  if (mapped !== "MEMORY.md" && !mapped.startsWith("memory/")) {
    throw new Error("memory_get only allows MEMORY.md or memory/* paths");
  }

  const absolute = path.resolve(vaultPath, mapped);
  const vaultRootWithSep = vaultPath.endsWith(path.sep) ? vaultPath : `${vaultPath}${path.sep}`;
  if (absolute !== vaultPath && !absolute.startsWith(vaultRootWithSep)) {
    throw new Error("Path escapes vault root");
  }

  return absolute;
}

function resolveManagerVaultPath(
  options: ClawVaultMemoryManagerOptions,
  sessionKey?: string
): string | null {
  const derivedAgentId = sessionKey ? extractAgentIdFromSessionKey(sessionKey) : "";
  const agentId = derivedAgentId || options.defaultAgentId;
  return resolveVaultPathForAgent(options.pluginConfig, {
    agentId,
    cwd: options.workspaceDir
  });
}

export class ClawVaultMemoryManager implements MemorySearchManager {
  private readonly options: ClawVaultMemoryManagerOptions;

  constructor(options: ClawVaultMemoryManagerOptions) {
    this.options = options;
  }

  async search(
    query: string,
    opts: { maxResults?: number; minScore?: number; sessionKey?: string } = {}
  ): Promise<MemorySearchResult[]> {
    const normalizedQuery = sanitizePromptForContext(query);
    if (!normalizedQuery) return [];

    const vaultPath = resolveManagerVaultPath(this.options, opts.sessionKey);
    if (!vaultPath) return [];

    const maxResults = Number.isFinite(opts.maxResults)
      ? clamp(Math.floor(Number(opts.maxResults)), 1, 20)
      : DEFAULT_MAX_RESULTS;
    const minScore = Number.isFinite(opts.minScore)
      ? clamp(Number(opts.minScore), 0, 1)
      : DEFAULT_MIN_SCORE;

    try {
      const vault = new ClawVault(vaultPath);
      await vault.load();
      const results = await vault.find(normalizedQuery, {
        limit: maxResults,
        minScore,
        temporalBoost: true
      });
      return results.map((result) => mapSearchResult(vaultPath, result));
    } catch (error) {
      this.options.logger?.warn(
        `[clawvault] memory_search fallback error: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<{ text: string; path: string }> {
    const vaultPath = resolveManagerVaultPath(this.options);
    const normalizedPath = normalizeRelPath(params.relPath);
    if (!vaultPath) {
      return { text: "", path: normalizedPath };
    }

    let absolutePath: string;
    try {
      absolutePath = toSafeFilePath(vaultPath, normalizedPath);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Invalid memory path");
    }

    if (!fs.existsSync(absolutePath)) {
      return { text: "", path: normalizedPath };
    }

    const raw = fs.readFileSync(absolutePath, "utf-8");
    if (!Number.isFinite(params.from) && !Number.isFinite(params.lines)) {
      return { text: raw, path: normalizedPath };
    }

    const from = Number.isFinite(params.from) ? Math.max(1, Math.floor(Number(params.from))) : 1;
    const lines = Number.isFinite(params.lines) ? Math.max(1, Math.floor(Number(params.lines))) : 120;
    const chunks = raw.split(/\r?\n/);
    const startIndex = from - 1;
    const sliced = chunks.slice(startIndex, startIndex + lines);
    return {
      text: sliced.join("\n"),
      path: normalizedPath
    };
  }

  status(): MemoryProviderStatus {
    const vaultPath = resolveManagerVaultPath(this.options);
    const markdownFiles = vaultPath ? countMarkdownFiles(path.join(vaultPath, "memory")) : 0;
    return {
      backend: "builtin",
      provider: "clawvault",
      workspaceDir: vaultPath ?? this.options.workspaceDir,
      files: markdownFiles,
      sources: ["memory", "sessions"],
      vector: {
        enabled: true,
        available: hasQmd()
      }
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: { completed: number; total: number; label?: string }) => void;
  }): Promise<void> {
    params?.progress?.({ completed: 0, total: 1, label: "syncing" });
    const vaultPath = resolveManagerVaultPath(this.options);
    if (vaultPath) {
      const vault = new ClawVault(vaultPath);
      await vault.load();
    }
    params?.progress?.({ completed: 1, total: 1, label: "done" });
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const sample = await this.search("health probe", { maxResults: 1, minScore: 0 });
      if (sample.length >= 0) {
        return { ok: true };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    return hasQmd();
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

function buildToolSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

export function createMemorySearchToolFactory(memoryManager: MemorySearchManager): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      query: {
        type: "string",
        description: "Natural-language query for memory recall."
      },
      maxResults: {
        type: "number",
        minimum: 1,
        maximum: 20,
        description: "Maximum number of snippets to return."
      },
      minScore: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Minimum score threshold."
      },
      sessionKey: {
        type: "string",
        description: "Optional OpenClaw session key for scoped recall."
      }
    }, ["query"]);

    const execute = async (input: Record<string, unknown>) => {
      const query = typeof input.query === "string" ? input.query : "";
      if (!query.trim()) {
        return { query, count: 0, results: [] };
      }
      const results = await memoryManager.search(query, {
        maxResults: Number.isFinite(Number(input.maxResults)) ? Number(input.maxResults) : undefined,
        minScore: Number.isFinite(Number(input.minScore)) ? Number(input.minScore) : undefined,
        sessionKey: typeof input.sessionKey === "string" ? input.sessionKey : undefined
      });
      return {
        query,
        count: results.length,
        results
      };
    };

    return {
      name: "memory_search",
      description: "Search ClawVault memory for relevant snippets before answering.",
      inputSchema,
      input_schema: inputSchema,
      parameters: inputSchema,
      execute,
      run: execute,
      handler: execute
    };
  };
}

export function createMemoryGetToolFactory(memoryManager: MemorySearchManager): () => Record<string, unknown> {
  return () => {
    const inputSchema = buildToolSchema({
      relPath: {
        type: "string",
        description: "Relative path from memory_search result (e.g. memory/2026-01-01.md)."
      },
      from: {
        type: "number",
        minimum: 1,
        description: "Optional start line (1-indexed)."
      },
      lines: {
        type: "number",
        minimum: 1,
        maximum: 400,
        description: "Optional number of lines to read."
      }
    }, ["relPath"]);

    const execute = async (input: Record<string, unknown>) => {
      const relPath = typeof input.relPath === "string" ? input.relPath : "";
      if (!relPath.trim()) {
        return { path: relPath, text: "" };
      }
      return memoryManager.readFile({
        relPath,
        from: Number.isFinite(Number(input.from)) ? Number(input.from) : undefined,
        lines: Number.isFinite(Number(input.lines)) ? Number(input.lines) : undefined
      });
    };

    return {
      name: "memory_get",
      description: "Read a specific memory file or line range from ClawVault.",
      inputSchema,
      input_schema: inputSchema,
      parameters: inputSchema,
      execute,
      run: execute,
      handler: execute
    };
  };
}
