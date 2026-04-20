import * as path from "path";
import { ClawVault } from "../lib/vault.js";
import { buildSessionRecap } from "../commands/session-recap.js";
import type { SearchResult } from "../types.js";
import type { ClawVaultPluginConfig } from "./config.js";
import {
  resolveVaultPathForAgent,
  formatSessionContextInjection,
  sanitizeForDisplay,
  sanitizePromptForContext,
  resolveSessionKey,
  type ContextEntry,
  type SessionRecapEntry
} from "./clawvault-cli.js";

const DEFAULT_MAX_CONTEXT_RESULTS = 4;
const DEFAULT_MAX_RECAP_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.2;
const MAX_CONTEXT_SNIPPET_LENGTH = 220;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncateContextSnippet(snippet: string): string {
  const normalized = sanitizeForDisplay(snippet).replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_CONTEXT_SNIPPET_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_CONTEXT_SNIPPET_LENGTH - 3).trimEnd()}...`;
}

function toRelativeVaultPath(vaultPath: string, absolutePath: string): string {
  const rel = path.relative(vaultPath, absolutePath).replace(/\\/g, "/");
  return rel.startsWith(".") ? path.basename(absolutePath) : rel;
}

function formatAgeLabel(modifiedAt: Date): string {
  const modified = modifiedAt.getTime();
  if (!Number.isFinite(modified)) {
    return "unknown age";
  }

  const elapsedMs = Date.now() - modified;
  if (elapsedMs < ONE_DAY_MS) {
    return "today";
  }
  const days = Math.max(1, Math.floor(elapsedMs / ONE_DAY_MS));
  if (days < 7) {
    return `${days}d ago`;
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {
    return `${weeks}w ago`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months}mo ago`;
  }
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function mapSearchResultToContextEntry(vaultPath: string, result: SearchResult): ContextEntry | null {
  const snippet = truncateContextSnippet(result.snippet);
  if (!snippet) {
    return null;
  }

  return {
    title: sanitizeForDisplay(result.document.title || "Untitled"),
    path: sanitizeForDisplay(toRelativeVaultPath(vaultPath, result.document.path)),
    age: formatAgeLabel(result.document.modified),
    snippet,
    score: Number.isFinite(result.score) ? result.score : 0
  };
}

export interface VaultContextInjectorOptions {
  prompt: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir?: string;
  pluginConfig: ClawVaultPluginConfig;
  contextProfile?: "default" | "planning" | "incident" | "handoff" | "auto";
  maxResults?: number;
}

export interface VaultContextInjectionResult {
  prependSystemContext: string;
  memoryEntries: ContextEntry[];
  recapEntries: SessionRecapEntry[];
  vaultPath: string | null;
}

export async function fetchSessionRecapEntries(
  options: Pick<VaultContextInjectorOptions, "sessionKey" | "agentId" | "pluginConfig">
): Promise<SessionRecapEntry[]> {
  const sessionKey = resolveSessionKey(options.sessionKey);
  if (!sessionKey) return [];

  try {
    const recap = await buildSessionRecap(sessionKey, {
      agentId: options.agentId,
      limit: DEFAULT_MAX_RECAP_RESULTS
    });
    return recap.messages
      .slice(-DEFAULT_MAX_RECAP_RESULTS)
      .map((entry) => {
        const text = sanitizeForDisplay(entry.text);
        if (!text) return null;
        return {
          role: entry.role === "user" ? "User" : "Assistant",
          text
        } satisfies SessionRecapEntry;
      })
      .filter((entry): entry is SessionRecapEntry => Boolean(entry));
  } catch {
    return [];
  }
}

export async function fetchMemoryContextEntries(
  options: VaultContextInjectorOptions
): Promise<{ entries: ContextEntry[]; vaultPath: string | null }> {
  const prompt = sanitizePromptForContext(options.prompt);
  if (!prompt) {
    return { entries: [], vaultPath: null };
  }

  const vaultPath = resolveVaultPathForAgent(options.pluginConfig, {
    agentId: options.agentId,
    cwd: options.workspaceDir
  });
  if (!vaultPath) {
    return { entries: [], vaultPath: null };
  }

  const maxResults = Number.isFinite(options.maxResults)
    ? clamp(Math.floor(Number(options.maxResults)), 1, 20)
    : DEFAULT_MAX_CONTEXT_RESULTS;

  try {
    const vault = new ClawVault(vaultPath);
    await vault.load();
    const matches = await vault.find(prompt, {
      limit: maxResults,
      minScore: DEFAULT_MIN_SCORE,
      temporalBoost: true
    });
    const entries = matches
      .map((match) => mapSearchResultToContextEntry(vaultPath, match))
      .filter((entry): entry is ContextEntry => Boolean(entry));
    return { entries, vaultPath };
  } catch {
    return { entries: [], vaultPath };
  }
}

export async function buildVaultContextInjection(
  options: VaultContextInjectorOptions
): Promise<VaultContextInjectionResult> {
  const [recapEntries, memoryResult] = await Promise.all([
    fetchSessionRecapEntries(options),
    fetchMemoryContextEntries(options)
  ]);

  if (recapEntries.length === 0 && memoryResult.entries.length === 0) {
    return {
      prependSystemContext: "",
      memoryEntries: [],
      recapEntries: [],
      vaultPath: memoryResult.vaultPath
    };
  }

  return {
    prependSystemContext: formatSessionContextInjection(recapEntries, memoryResult.entries),
    memoryEntries: memoryResult.entries,
    recapEntries,
    vaultPath: memoryResult.vaultPath
  };
}
