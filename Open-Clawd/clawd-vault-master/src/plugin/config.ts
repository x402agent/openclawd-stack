import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { OpenClawPluginApi, PluginHookAgentContext } from "./openclaw-types.js";

const SESSION_KEY_RE = /^agent:[a-zA-Z0-9_-]+:[a-zA-Z0-9:_-]+$/;
const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;

export type ClawVaultContextProfile = "default" | "planning" | "incident" | "handoff" | "auto";

export interface ClawVaultPluginConfig {
  vaultPath?: string;
  agentVaults?: Record<string, string>;
  allowClawvaultExec?: boolean;
  clawvaultBinaryPath?: string;
  clawvaultBinarySha256?: string;
  allowEnvAccess?: boolean;
  enableStartupRecovery?: boolean;
  enableSessionContextInjection?: boolean;
  enableAutoCheckpoint?: boolean;
  enableObserveOnNew?: boolean;
  enableHeartbeatObservation?: boolean;
  enableCompactionObservation?: boolean;
  enableWeeklyReflection?: boolean;
  enableFactExtraction?: boolean;
  autoCheckpoint?: boolean;
  observeOnHeartbeat?: boolean;
  weeklyReflection?: boolean;
  contextProfile?: ClawVaultContextProfile;
  maxContextResults?: number;
  enableBeforePromptRecall?: boolean;
  enforceCommunicationProtocol?: boolean;
  enableMessageSendingFilter?: boolean;
  minQuestionRecallScore?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readPluginConfig(api: Pick<OpenClawPluginApi, "pluginConfig">): ClawVaultPluginConfig {
  if (!isRecord(api.pluginConfig)) {
    return {};
  }
  return api.pluginConfig as ClawVaultPluginConfig;
}

export function isOptInEnabled(pluginConfig: ClawVaultPluginConfig, ...keys: Array<keyof ClawVaultPluginConfig>): boolean {
  return keys.some((key) => pluginConfig[key] === true);
}

export function isFeatureEnabled(
  pluginConfig: ClawVaultPluginConfig,
  key: keyof ClawVaultPluginConfig,
  defaultValue: boolean
): boolean {
  const value = pluginConfig[key];
  if (typeof value === "boolean") return value;
  return defaultValue;
}

export function allowsEnvAccess(pluginConfig: ClawVaultPluginConfig): boolean {
  return isOptInEnabled(pluginConfig, "allowEnvAccess");
}

export function sanitizeSessionKey(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!SESSION_KEY_RE.test(trimmed)) return "";
  return trimmed.slice(0, 200);
}

export function sanitizeAgentId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!AGENT_ID_RE.test(trimmed)) return "";
  return trimmed;
}

export function extractAgentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  if (!match?.[1]) return "";
  return sanitizeAgentId(match[1]);
}

export function resolveAgentId(
  ctx: Pick<PluginHookAgentContext, "agentId" | "sessionKey">,
  pluginConfig: ClawVaultPluginConfig
): string {
  const fromContext = sanitizeAgentId(ctx.agentId);
  if (fromContext) return fromContext;

  const fromSessionKey = extractAgentIdFromSessionKey(sanitizeSessionKey(ctx.sessionKey));
  if (fromSessionKey) return fromSessionKey;

  if (allowsEnvAccess(pluginConfig)) {
    const fromEnv = sanitizeAgentId(process.env.OPENCLAW_AGENT_ID);
    if (fromEnv) return fromEnv;
  }

  return "main";
}

export function getConfiguredExecutablePath(pluginConfig: ClawVaultPluginConfig): string | null {
  if (typeof pluginConfig.clawvaultBinaryPath !== "string") return null;
  const trimmed = pluginConfig.clawvaultBinaryPath.trim();
  return trimmed || null;
}

export function getConfiguredExecutableSha256(pluginConfig: ClawVaultPluginConfig): string | null {
  if (typeof pluginConfig.clawvaultBinarySha256 !== "string") return null;
  const trimmed = pluginConfig.clawvaultBinarySha256.trim().toLowerCase();
  return trimmed || null;
}

function normalizeAbsoluteEnvPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const resolved = path.resolve(trimmed);
  if (!path.isAbsolute(resolved)) return null;
  return resolved;
}

export function getOpenClawAgentsDir(pluginConfig: ClawVaultPluginConfig): string {
  if (allowsEnvAccess(pluginConfig)) {
    const stateDir = normalizeAbsoluteEnvPath(process.env.OPENCLAW_STATE_DIR);
    if (stateDir) {
      return path.join(stateDir, "agents");
    }

    const openClawHome = normalizeAbsoluteEnvPath(process.env.OPENCLAW_HOME);
    if (openClawHome) {
      return path.join(openClawHome, "agents");
    }
  }

  return path.join(os.homedir(), ".openclaw", "agents");
}

export function validateVaultPath(vaultPath: string | undefined | null): string | null {
  if (!vaultPath || typeof vaultPath !== "string") return null;

  const resolved = path.resolve(vaultPath);
  if (!path.isAbsolute(resolved)) return null;

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  const configPath = path.join(resolved, ".clawvault.json");
  if (!fs.existsSync(configPath)) return null;

  return resolved;
}

function resolveAgentVaultPath(pluginConfig: ClawVaultPluginConfig, agentId: string): string | null {
  if (!agentId) return null;
  if (!isRecord(pluginConfig.agentVaults)) return null;

  const configured = pluginConfig.agentVaults[agentId];
  if (typeof configured !== "string") return null;
  return validateVaultPath(configured);
}

export function findVaultPath(
  pluginConfig: ClawVaultPluginConfig,
  options: { agentId?: string; cwd?: string } = {}
): string | null {
  const agentId = sanitizeAgentId(options.agentId);
  if (agentId) {
    const perAgent = resolveAgentVaultPath(pluginConfig, agentId);
    if (perAgent) return perAgent;
  }

  const configured = validateVaultPath(pluginConfig.vaultPath ?? null);
  if (configured) return configured;

  if (allowsEnvAccess(pluginConfig)) {
    const fromPluginEnv = validateVaultPath(process.env.OPENCLAW_PLUGIN_CLAWVAULT_VAULTPATH ?? null);
    if (fromPluginEnv) return fromPluginEnv;

    const fromClawVaultEnv = validateVaultPath(process.env.CLAWVAULT_PATH ?? null);
    if (fromClawVaultEnv) return fromClawVaultEnv;
  }

  let dir = path.resolve(options.cwd ?? process.cwd());
  const root = path.parse(dir).root;

  while (dir !== root) {
    const direct = validateVaultPath(dir);
    if (direct) return direct;

    const memorySubdir = validateVaultPath(path.join(dir, "memory"));
    if (memorySubdir) return memorySubdir;

    dir = path.dirname(dir);
  }

  return null;
}
