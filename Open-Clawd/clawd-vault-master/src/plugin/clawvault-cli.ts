import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  ClawVaultPluginConfig,
  extractAgentIdFromSessionKey,
  findVaultPath,
  getConfiguredExecutablePath,
  getConfiguredExecutableSha256,
  getOpenClawAgentsDir,
  isOptInEnabled,
  sanitizeSessionKey
} from "./config.js";
import { resolveExecutablePath, sanitizeExecArgs, verifyExecutableIntegrity } from "./integrity.js";

const MAX_CONTEXT_PROMPT_LENGTH = 500;
const MAX_CONTEXT_SNIPPET_LENGTH = 220;
const MAX_RECAP_SNIPPET_LENGTH = 220;
const CLAWVAULT_EXECUTABLE = "clawvault";
const ONE_KIB = 1024;
const ONE_MIB = ONE_KIB * ONE_KIB;
const SMALL_SESSION_THRESHOLD_BYTES = 50 * ONE_KIB;
const MEDIUM_SESSION_THRESHOLD_BYTES = 150 * ONE_KIB;
const LARGE_SESSION_THRESHOLD_BYTES = 300 * ONE_KIB;

const OBSERVE_CURSOR_FILE = "observe-cursors.json";

export interface ClawVaultCommandResult {
  success: boolean;
  output: string;
  code: number;
  skipped?: boolean;
}

export interface ContextEntry {
  title: string;
  path: string;
  age: string;
  snippet: string;
  score: number;
}

export interface SessionRecapEntry {
  role: "User" | "Assistant";
  text: string;
}

export function sanitizeForDisplay(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[`*_~\[\]]/g, "\\$&")
    .slice(0, 240);
}

export function sanitizePromptForContext(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CONTEXT_PROMPT_LENGTH);
}

function truncateSnippet(snippet: string): string {
  const safe = sanitizeForDisplay(snippet).replace(/\s+/g, " ").trim();
  if (safe.length <= MAX_CONTEXT_SNIPPET_LENGTH) return safe;
  return `${safe.slice(0, MAX_CONTEXT_SNIPPET_LENGTH - 3).trimEnd()}...`;
}

function truncateRecapSnippet(snippet: string): string {
  const safe = sanitizeForDisplay(snippet).replace(/\s+/g, " ").trim();
  if (safe.length <= MAX_RECAP_SNIPPET_LENGTH) return safe;
  return `${safe.slice(0, MAX_RECAP_SNIPPET_LENGTH - 3).trimEnd()}...`;
}

export function parseContextJson(output: string, maxResults: number): ContextEntry[] {
  try {
    const parsed = JSON.parse(output) as { context?: Array<Record<string, unknown>> };
    if (!parsed || !Array.isArray(parsed.context)) return [];
    return parsed.context
      .slice(0, maxResults)
      .map((entry) => ({
        title: sanitizeForDisplay(entry.title ?? "Untitled"),
        path: sanitizeForDisplay(entry.path ?? ""),
        age: sanitizeForDisplay(entry.age ?? "unknown age"),
        snippet: truncateSnippet(String(entry.snippet ?? "")),
        score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : 0
      }))
      .filter((entry) => entry.snippet.length > 0);
  } catch {
    return [];
  }
}

export function parseSessionRecapJson(output: string, maxResults: number): SessionRecapEntry[] {
  try {
    const parsed = JSON.parse(output) as { messages?: Array<Record<string, unknown>> };
    if (!parsed || !Array.isArray(parsed.messages)) return [];
    return parsed.messages
      .map((entry) => {
        const role = typeof entry.role === "string" ? entry.role.toLowerCase() : "";
        if (role !== "user" && role !== "assistant") return null;
        const text = truncateRecapSnippet(typeof entry.text === "string" ? entry.text : "");
        if (!text) return null;
        return {
          role: role === "user" ? "User" : "Assistant",
          text
        } satisfies SessionRecapEntry;
      })
      .filter((entry): entry is SessionRecapEntry => Boolean(entry))
      .slice(-maxResults);
  } catch {
    return [];
  }
}

export function formatSessionContextInjection(
  recapEntries: SessionRecapEntry[],
  memoryEntries: ContextEntry[]
): string {
  const lines = [
    "[ClawVault] Session context restored:",
    "",
    "Recent conversation:"
  ];

  if (recapEntries.length === 0) {
    lines.push("- No recent user/assistant turns found for this session.");
  } else {
    for (const entry of recapEntries) {
      lines.push(`- ${entry.role}: ${entry.text}`);
    }
  }

  lines.push("", "Relevant memories:");
  if (memoryEntries.length === 0) {
    lines.push("- No relevant vault memories found for the current prompt.");
  } else {
    for (const entry of memoryEntries) {
      const pathSuffix = entry.path ? ` [${entry.path}]` : "";
      lines.push(`- ${entry.title} (${entry.age}${pathSuffix}): ${entry.snippet}`);
    }
  }

  return lines.join("\n");
}

export function resolveVaultPathForAgent(
  pluginConfig: ClawVaultPluginConfig,
  options: { agentId?: string; cwd?: string } = {}
): string | null {
  return findVaultPath(pluginConfig, options);
}

export function runClawvault(
  args: string[],
  pluginConfig: ClawVaultPluginConfig,
  options: { timeoutMs?: number } = {}
): ClawVaultCommandResult {
  if (!isOptInEnabled(pluginConfig, "allowClawvaultExec")) {
    return {
      success: false,
      skipped: true,
      output: "ClawVault CLI execution is disabled. Set allowClawvaultExec=true to enable.",
      code: 0
    };
  }

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1_000, Number(options.timeoutMs))
    : 15_000;

  const executablePath = resolveExecutablePath(CLAWVAULT_EXECUTABLE, {
    explicitPath: getConfiguredExecutablePath(pluginConfig)
  });
  if (!executablePath) {
    return {
      success: false,
      output: "Unable to resolve clawvault executable path.",
      code: 1
    };
  }

  const expectedSha256 = getConfiguredExecutableSha256(pluginConfig);
  const integrityResult = verifyExecutableIntegrity(executablePath, expectedSha256);
  if (!integrityResult.ok) {
    return {
      success: false,
      output: `Executable integrity verification failed for ${executablePath}.`,
      code: 1
    };
  }

  let sanitizedArgs: string[];
  try {
    sanitizedArgs = sanitizeExecArgs(args);
  } catch (error) {
    return {
      success: false,
      output: error instanceof Error ? error.message : "Invalid command arguments",
      code: 1
    };
  }

  try {
    const output = execFileSync(executablePath, sanitizedArgs, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false
    });
    return {
      success: true,
      output: output.trim(),
      code: 0
    };
  } catch (error) {
    const details = error as {
      stderr?: Buffer | string;
      message?: string;
      status?: number;
    };
    return {
      success: false,
      output: details.stderr?.toString() || details.message || "unknown error",
      code: details.status || 1
    };
  }
}

export function parseRecoveryOutput(output: string): { hadDeath: boolean; workingOn: string | null } {
  if (!output || typeof output !== "string") {
    return { hadDeath: false, workingOn: null };
  }

  const hadDeath = output.includes("Context death detected")
    || output.includes("died")
    || output.includes("⚠️");

  if (!hadDeath) {
    return { hadDeath: false, workingOn: null };
  }

  const workingOnLine = output
    .split("\n")
    .find((line) => line.toLowerCase().includes("working on"));
  if (!workingOnLine) {
    return { hadDeath: true, workingOn: null };
  }

  const parts = workingOnLine.split(":");
  const workingOn = parts.length > 1
    ? sanitizeForDisplay(parts.slice(1).join(":").trim())
    : null;

  return { hadDeath: true, workingOn: workingOn || null };
}

function getObserveCursorPath(vaultPath: string): string {
  return path.join(vaultPath, ".clawvault", OBSERVE_CURSOR_FILE);
}

function loadObserveCursors(vaultPath: string): Record<string, { lastObservedOffset?: number }> {
  const cursorPath = getObserveCursorPath(vaultPath);
  if (!fs.existsSync(cursorPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cursorPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, { lastObservedOffset?: number }>;
  } catch {
    return {};
  }
}

function getScaledObservationThresholdBytes(fileSizeBytes: number): number {
  if (!Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0) {
    return SMALL_SESSION_THRESHOLD_BYTES;
  }
  if (fileSizeBytes < ONE_MIB) {
    return SMALL_SESSION_THRESHOLD_BYTES;
  }
  if (fileSizeBytes <= 5 * ONE_MIB) {
    return MEDIUM_SESSION_THRESHOLD_BYTES;
  }
  return LARGE_SESSION_THRESHOLD_BYTES;
}

function parseSessionIndex(agentId: string, pluginConfig: ClawVaultPluginConfig): {
  sessionsDir: string;
  index: Record<string, { sessionId?: string }>;
} {
  const sessionsDir = path.join(getOpenClawAgentsDir(pluginConfig), agentId, "sessions");
  const sessionsJsonPath = path.join(sessionsDir, "sessions.json");
  if (!fs.existsSync(sessionsJsonPath)) {
    return { sessionsDir, index: {} };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(sessionsJsonPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { sessionsDir, index: {} };
    }
    return {
      sessionsDir,
      index: parsed as Record<string, { sessionId?: string }>
    };
  } catch {
    return { sessionsDir, index: {} };
  }
}

export function shouldObserveActiveSessions(
  vaultPath: string,
  agentId: string,
  pluginConfig: ClawVaultPluginConfig
): boolean {
  const cursors = loadObserveCursors(vaultPath);
  const { sessionsDir, index } = parseSessionIndex(agentId, pluginConfig);
  const entries = Object.entries(index);
  if (entries.length === 0) {
    return false;
  }

  for (const [sessionKey, value] of entries) {
    const sessionId = typeof value?.sessionId === "string" ? value.sessionId.trim() : "";
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(sessionId)) continue;

    const filePath = path.join(sessionsDir, `${sessionId}.jsonl`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const fileSize = stat.size;
    const cursorEntry = cursors[sessionId];
    const previousOffset = Number.isFinite(cursorEntry?.lastObservedOffset)
      ? Math.max(0, Number(cursorEntry.lastObservedOffset))
      : 0;
    const startOffset = previousOffset <= fileSize ? previousOffset : 0;
    const newBytes = Math.max(0, fileSize - startOffset);
    const thresholdBytes = getScaledObservationThresholdBytes(fileSize);

    if (newBytes >= thresholdBytes) {
      return true;
    }

    if (sessionKey === "main" && newBytes > 0) {
      // no-op branch to avoid lint warnings in strict setups
    }
  }

  return false;
}

export function runObserverCron(
  vaultPath: string,
  agentId: string,
  pluginConfig: ClawVaultPluginConfig,
  options: { minNewBytes?: number; reason?: string } = {}
): boolean {
  if (!isOptInEnabled(pluginConfig, "allowClawvaultExec")) {
    return false;
  }

  const executablePath = resolveExecutablePath(CLAWVAULT_EXECUTABLE, {
    explicitPath: getConfiguredExecutablePath(pluginConfig)
  });
  if (!executablePath) {
    return false;
  }

  const expectedSha256 = getConfiguredExecutableSha256(pluginConfig);
  const integrityResult = verifyExecutableIntegrity(executablePath, expectedSha256);
  if (!integrityResult.ok) {
    return false;
  }

  const args = ["observe", "--cron", "--agent", agentId, "-v", vaultPath];
  if (Number.isFinite(options.minNewBytes) && Number(options.minNewBytes) > 0) {
    args.push("--min-new", String(Math.floor(Number(options.minNewBytes))));
  }

  let sanitizedArgs: string[];
  try {
    sanitizedArgs = sanitizeExecArgs(args);
  } catch {
    return false;
  }

  try {
    const child = spawn(executablePath, sanitizedArgs, {
      stdio: "ignore",
      shell: false
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function resolveSessionKey(input: unknown): string {
  return sanitizeSessionKey(input);
}

