import type { PluginHookBeforePromptBuildEvent, PluginHookBeforePromptBuildResult, PluginHookAgentContext } from "../openclaw-types.js";
import type { ClawVaultPluginConfig } from "../config.js";
import { isFeatureEnabled } from "../config.js";
import { buildCommunicationProtocolAppendix } from "../communication-protocol.js";
import { buildVaultContextInjection, type VaultContextInjectionResult } from "../vault-context-injector.js";
import type { ClawVaultPluginRuntimeState } from "../runtime-state.js";

const MEMORY_RECALL_MANDATE = [
  "ClawVault Memory Recall Policy:",
  "- Before answering anything about prior work, people, decisions, preferences, todos, or historical context, call memory_search first.",
  "- If memory_search returns relevant snippets, ground your answer in those snippets and use memory_get when details are needed.",
  "- Do not guess from stale context when memory lookup is available."
].join("\n");

export interface BeforePromptBuildDependencies {
  pluginConfig: ClawVaultPluginConfig;
  runtimeState: ClawVaultPluginRuntimeState;
  contextInjector?: (input: {
    prompt: string;
    sessionKey?: string;
    agentId?: string;
    workspaceDir?: string;
    pluginConfig: ClawVaultPluginConfig;
    contextProfile?: "default" | "planning" | "incident" | "handoff" | "auto";
    maxResults?: number;
  }) => Promise<VaultContextInjectionResult>;
}

function appendSection(target: string[], section: string | undefined | null): void {
  if (!section) return;
  const trimmed = section.trim();
  if (!trimmed) return;
  target.push(trimmed);
}

export function createBeforePromptBuildHandler(
  dependencies: BeforePromptBuildDependencies
): (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforePromptBuildResult | void> {
  const contextInjector = dependencies.contextInjector ?? buildVaultContextInjection;

  return async (event, ctx) => {
    const prependSections: string[] = [];
    const appendSections: string[] = [];

    const recallEnabled = isFeatureEnabled(dependencies.pluginConfig, "enableBeforePromptRecall", true);
    const protocolEnabled = isFeatureEnabled(dependencies.pluginConfig, "enforceCommunicationProtocol", true);
    const contextInjectionEnabled = isFeatureEnabled(dependencies.pluginConfig, "enableSessionContextInjection", true);

    if (recallEnabled) {
      prependSections.push(MEMORY_RECALL_MANDATE);
    }

    const startupNotice = dependencies.runtimeState.consumeStartupRecoveryNotice();
    appendSection(prependSections, startupNotice ? `[ClawVault Recovery]\n${startupNotice}` : "");

    if (ctx.sessionKey) {
      const sessionCacheEntry = dependencies.runtimeState.getSessionRecap(ctx.sessionKey);
      if (sessionCacheEntry?.recapText && !sessionCacheEntry.recapInjected) {
        appendSection(prependSections, sessionCacheEntry.recapText);
        dependencies.runtimeState.markSessionRecapInjected(ctx.sessionKey);
      }
    }

    if (contextInjectionEnabled) {
      const injection = await contextInjector({
        prompt: event.prompt,
        sessionKey: ctx.sessionKey,
        agentId: ctx.agentId,
        workspaceDir: ctx.workspaceDir,
        pluginConfig: dependencies.pluginConfig,
        contextProfile: dependencies.pluginConfig.contextProfile,
        maxResults: dependencies.pluginConfig.maxContextResults
      });
      appendSection(prependSections, injection.prependSystemContext);
    }

    if (protocolEnabled) {
      appendSections.push(buildCommunicationProtocolAppendix());
    }

    if (prependSections.length === 0 && appendSections.length === 0) {
      return;
    }

    return {
      prependSystemContext: prependSections.join("\n\n"),
      appendSystemContext: appendSections.join("\n\n")
    };
  };
}
