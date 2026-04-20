import type { PluginHookAgentContext, PluginHookAgentEndEvent, PluginHookBeforeCompactionEvent } from "../openclaw-types.js";
import type { ClawVaultPluginConfig } from "../config.js";
import { isOptInEnabled, resolveAgentId } from "../config.js";
import { resolveVaultPathForAgent, runObserverCron, shouldObserveActiveSessions } from "../clawvault-cli.js";
import { runFactExtractionForEvent } from "../fact-extractor.js";

export interface ObservationHookDependencies {
  pluginConfig: ClawVaultPluginConfig;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

export async function handleAgentEndHeartbeat(
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
  deps: ObservationHookDependencies
): Promise<void> {
  if (!isOptInEnabled(deps.pluginConfig, "enableHeartbeatObservation", "observeOnHeartbeat")) {
    return;
  }

  const agentId = resolveAgentId(ctx, deps.pluginConfig);
  const vaultPath = resolveVaultPathForAgent(deps.pluginConfig, {
    agentId,
    cwd: ctx.workspaceDir
  });
  if (!vaultPath) {
    return;
  }

  if (!shouldObserveActiveSessions(vaultPath, agentId, deps.pluginConfig)) {
    return;
  }

  const observed = runObserverCron(vaultPath, agentId, deps.pluginConfig, {
    reason: "agent_end heartbeat"
  });
  if (!observed) {
    deps.logger?.warn("[clawvault] Heartbeat observation trigger failed");
  }

  if (!event.success && event.error) {
    deps.logger?.info(`[clawvault] Agent ended with error: ${event.error}`);
  }
}

export async function handleBeforeCompactionObservation(
  event: PluginHookBeforeCompactionEvent,
  ctx: PluginHookAgentContext,
  deps: ObservationHookDependencies
): Promise<void> {
  const compactionObserveEnabled = isOptInEnabled(deps.pluginConfig, "enableCompactionObservation");
  const factExtractionEnabled = isOptInEnabled(deps.pluginConfig, "enableFactExtraction");
  if (!compactionObserveEnabled && !factExtractionEnabled) {
    return;
  }

  const agentId = resolveAgentId(ctx, deps.pluginConfig);
  const vaultPath = resolveVaultPathForAgent(deps.pluginConfig, {
    agentId,
    cwd: ctx.workspaceDir
  });
  if (!vaultPath) {
    return;
  }

  if (compactionObserveEnabled) {
    runObserverCron(vaultPath, agentId, deps.pluginConfig, {
      minNewBytes: 1,
      reason: "before_compaction"
    });
  }

  if (factExtractionEnabled) {
    runFactExtractionForEvent(vaultPath, event, "before_compaction");
  }
}
