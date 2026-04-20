import type {
  PluginHookAgentContext,
  PluginHookBeforeResetEvent,
  PluginHookGatewayStartEvent,
  PluginHookSessionEndEvent,
  PluginHookSessionStartEvent
} from "../openclaw-types.js";
import type { ClawVaultPluginConfig } from "../config.js";
import {
  extractAgentIdFromSessionKey,
  isOptInEnabled,
  resolveAgentId,
  sanitizeSessionKey
} from "../config.js";
import {
  fetchSessionRecapEntries
} from "../vault-context-injector.js";
import {
  resolveVaultPathForAgent,
  runObserverCron,
  formatSessionContextInjection
} from "../clawvault-cli.js";
import type { ClawVaultPluginRuntimeState } from "../runtime-state.js";
import { runFactExtractionForEvent } from "../fact-extractor.js";
import { recover as recoverContext } from "../../commands/recover.js";
import { checkpoint as saveCheckpoint, flush as flushCheckpoint } from "../../commands/checkpoint.js";
import { runReflection } from "../../observer/reflection-service.js";

export interface SessionLifecycleDependencies {
  pluginConfig: ClawVaultPluginConfig;
  runtimeState: ClawVaultPluginRuntimeState;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

function getWeekKey(date: Date): string {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const days = Math.floor((date.getTime() - start) / (24 * 60 * 60 * 1000));
  const week = Math.floor(days / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function isSundayMidnightUtc(date: Date): boolean {
  return date.getUTCDay() === 0 && date.getUTCHours() === 0 && date.getUTCMinutes() === 0;
}

async function runWeeklyReflectionIfNeeded(
  deps: SessionLifecycleDependencies,
  agentId: string,
  workspaceDir?: string
): Promise<void> {
  if (!isOptInEnabled(deps.pluginConfig, "enableWeeklyReflection", "weeklyReflection")) {
    return;
  }

  const now = new Date();
  if (!isSundayMidnightUtc(now)) {
    return;
  }

  const weekKey = getWeekKey(now);
  if (!deps.runtimeState.shouldRunWeeklyReflection(weekKey)) {
    return;
  }

  const vaultPath = resolveVaultPathForAgent(deps.pluginConfig, {
    agentId,
    cwd: workspaceDir
  });
  if (!vaultPath) {
    return;
  }

  try {
    const result = await runReflection({ vaultPath });
    if (result.writtenWeeks > 0) {
      deps.logger?.info("[clawvault] Weekly reflection complete");
    }
    deps.runtimeState.markWeeklyReflectionRun(weekKey);
  } catch {
    deps.logger?.warn("[clawvault] Weekly reflection failed");
  }
}

export async function handleGatewayStart(
  event: PluginHookGatewayStartEvent,
  ctx: { port?: number },
  deps: SessionLifecycleDependencies
): Promise<void> {
  const shouldRecover = isOptInEnabled(deps.pluginConfig, "enableStartupRecovery");
  if (!shouldRecover) {
    return;
  }

  const vaultPath = resolveVaultPathForAgent(deps.pluginConfig, { cwd: process.cwd(), agentId: "main" });
  if (!vaultPath) {
    deps.logger?.warn("[clawvault] No vault found, skipping startup recovery");
    return;
  }

  let recoveryInfo: Awaited<ReturnType<typeof recoverContext>>;
  try {
    recoveryInfo = await recoverContext(vaultPath, { clearFlag: true });
  } catch {
    deps.logger?.warn("[clawvault] Startup recovery command failed");
    return;
  }

  if (recoveryInfo.died) {
    const workingOn = recoveryInfo.checkpoint?.workingOn?.trim();
    const message = workingOn
      ? `[ClawVault] Context death detected. Last working on: ${workingOn}. Run \`clawvault wake\` for full recovery context.`
      : "[ClawVault] Context death detected. Run `clawvault wake` for full recovery context.";
    deps.runtimeState.setStartupRecoveryNotice(message);
    deps.logger?.warn("[clawvault] Context death detected at startup");
  }

  if (ctx.port || event.port) {
    // Keep lint happy while preserving typed args.
  }
}

export async function handleSessionStart(
  event: PluginHookSessionStartEvent,
  ctx: { sessionId: string; sessionKey?: string; agentId?: string },
  deps: SessionLifecycleDependencies
): Promise<void> {
  const sessionKey = sanitizeSessionKey(ctx.sessionKey ?? event.sessionKey);
  const agentId = resolveAgentId({ agentId: ctx.agentId, sessionKey }, deps.pluginConfig);

  if (isOptInEnabled(deps.pluginConfig, "enableSessionContextInjection")) {
    const recapEntries = await fetchSessionRecapEntries({
      sessionKey,
      agentId: extractAgentIdFromSessionKey(sessionKey) || agentId,
      pluginConfig: deps.pluginConfig
    });
    if (recapEntries.length > 0) {
      const recapInjection = formatSessionContextInjection(recapEntries, []);
      deps.runtimeState.setSessionRecap(sessionKey, recapInjection);
    }
  }

  await runWeeklyReflectionIfNeeded(deps, agentId, undefined);
}

function sanitizeForCheckpoint(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "unknown";
  const cleaned = value.replace(/[^a-zA-Z0-9:_ -]/g, "").trim();
  return cleaned.slice(0, maxLength) || "unknown";
}

export async function handleBeforeReset(
  event: PluginHookBeforeResetEvent,
  ctx: PluginHookAgentContext,
  deps: SessionLifecycleDependencies
): Promise<void> {
  const autoCheckpointEnabled = isOptInEnabled(deps.pluginConfig, "enableAutoCheckpoint", "autoCheckpoint");
  const observerOnResetEnabled = isOptInEnabled(deps.pluginConfig, "enableObserveOnNew");
  const factExtractionEnabled = isOptInEnabled(deps.pluginConfig, "enableFactExtraction");

  if (!autoCheckpointEnabled && !observerOnResetEnabled && !factExtractionEnabled) {
    return;
  }

  const sessionKey = sanitizeSessionKey(ctx.sessionKey);
  const agentId = resolveAgentId(ctx, deps.pluginConfig);
  const vaultPath = resolveVaultPathForAgent(deps.pluginConfig, {
    agentId,
    cwd: ctx.workspaceDir
  });
  if (!vaultPath) {
    return;
  }

  if (autoCheckpointEnabled) {
    const safeSessionKey = sanitizeForCheckpoint(sessionKey, 120);
    const safeReason = sanitizeForCheckpoint(event.reason ?? "before_reset", 80);
    try {
      await saveCheckpoint({
        workingOn: `Session reset via ${safeReason}`,
        focus: `Pre-reset checkpoint, session: ${safeSessionKey}`,
        vaultPath
      });
      await flushCheckpoint();
    } catch {
      deps.logger?.warn("[clawvault] Auto-checkpoint before reset failed");
    }
  }

  if (observerOnResetEnabled) {
    runObserverCron(vaultPath, agentId, deps.pluginConfig, {
      minNewBytes: 1,
      reason: "before_reset"
    });
  }

  if (factExtractionEnabled) {
    runFactExtractionForEvent(vaultPath, event, "before_reset");
  }
}

export async function handleSessionEnd(
  event: PluginHookSessionEndEvent,
  ctx: { sessionId: string; sessionKey?: string; agentId?: string },
  deps: SessionLifecycleDependencies
): Promise<void> {
  deps.runtimeState.clearSession(ctx.sessionKey ?? event.sessionKey);
}
