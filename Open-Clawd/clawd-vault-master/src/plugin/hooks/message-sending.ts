import type { PluginHookMessageSendingEvent, PluginHookMessageSendingResult, PluginHookMessageContext } from "../openclaw-types.js";
import type { ClawVaultPluginConfig } from "../config.js";
import { isFeatureEnabled } from "../config.js";
import type { MemorySearchManager } from "../memory-types.js";
import { containsQuestion, rewriteOutboundMessage, rewriteQuestionWithMemoryEvidence } from "../communication-protocol.js";

const DEFAULT_QUESTION_RECALL_MIN_SCORE = 0.35;

export interface MessageSendingDependencies {
  pluginConfig: ClawVaultPluginConfig;
  memoryManager: MemorySearchManager;
}

function normalizeScoreThreshold(config: ClawVaultPluginConfig): number {
  const raw = config.minQuestionRecallScore;
  if (!Number.isFinite(raw)) return DEFAULT_QUESTION_RECALL_MIN_SCORE;
  return Math.max(0, Math.min(1, Number(raw)));
}

export function createMessageSendingHandler(
  dependencies: MessageSendingDependencies
): (
  event: PluginHookMessageSendingEvent,
  ctx: PluginHookMessageContext
) => Promise<PluginHookMessageSendingResult | void> {
  return async (event, _ctx) => {
    const filterEnabled = isFeatureEnabled(dependencies.pluginConfig, "enableMessageSendingFilter", true);
    if (!filterEnabled) {
      return;
    }

    const rewritten = rewriteOutboundMessage(event.content);
    let content = rewritten.content;
    let shouldCancel = false;

    if (containsQuestion(content)) {
      const hits = await dependencies.memoryManager.search(content, {
        maxResults: 2,
        minScore: normalizeScoreThreshold(dependencies.pluginConfig)
      });
      if (hits.length > 0) {
        content = rewriteQuestionWithMemoryEvidence(content, hits);
        if (containsQuestion(content)) {
          shouldCancel = true;
        }
      }
    }

    if (!shouldCancel && content === event.content) {
      return;
    }

    if (shouldCancel) {
      return { cancel: true };
    }

    return { content };
  };
}
