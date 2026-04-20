import { createMemorySlotPlugin, registerMemorySlot } from "./plugin/slot.js";
import { readPluginConfig } from "./plugin/config.js";
import { ClawVaultMemoryManager, createMemoryGetToolFactory, createMemorySearchToolFactory } from "./plugin/memory-manager.js";
import { ClawVaultPluginRuntimeState } from "./plugin/runtime-state.js";
import { createBeforePromptBuildHandler } from "./plugin/hooks/before-prompt-build.js";
import { createMessageSendingHandler } from "./plugin/hooks/message-sending.js";
import {
  handleGatewayStart,
  handleSessionEnd,
  handleSessionStart,
  handleBeforeReset
} from "./plugin/hooks/session-lifecycle.js";
import {
  handleAgentEndHeartbeat,
  handleBeforeCompactionObservation
} from "./plugin/hooks/observation.js";
import type { OpenClawPluginApi } from "./plugin/openclaw-types.js";

function isOpenClawPluginApi(value: unknown): value is OpenClawPluginApi {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.on === "function"
    && typeof record.registerTool === "function"
    && typeof record.logger === "object";
}

function registerOpenClawPlugin(api: OpenClawPluginApi): {
  plugins: { slots: { memory: ClawVaultMemoryManager } };
} {
  const pluginConfig = readPluginConfig(api);
  const runtimeState = new ClawVaultPluginRuntimeState();
  const memoryManager = new ClawVaultMemoryManager({
    pluginConfig,
    defaultAgentId: "main",
    logger: {
      debug: api.logger.debug,
      warn: api.logger.warn
    }
  });

  api.registerTool(createMemorySearchToolFactory(memoryManager), { name: "memory_search" });
  api.registerTool(createMemoryGetToolFactory(memoryManager), { name: "memory_get" });

  api.on("before_prompt_build", createBeforePromptBuildHandler({
    pluginConfig,
    runtimeState
  }), { priority: 30 });

  api.on("message_sending", createMessageSendingHandler({
    pluginConfig,
    memoryManager
  }), { priority: 20 });

  api.on("gateway_start", async (event, ctx) => {
    await handleGatewayStart(event, ctx, {
      pluginConfig,
      runtimeState,
      logger: api.logger
    });
  });

  api.on("session_start", async (event, ctx) => {
    await handleSessionStart(event, ctx, {
      pluginConfig,
      runtimeState,
      logger: api.logger
    });
  });

  api.on("session_end", async (event, ctx) => {
    await handleSessionEnd(event, ctx, {
      pluginConfig,
      runtimeState,
      logger: api.logger
    });
  });

  api.on("before_reset", async (event, ctx) => {
    await handleBeforeReset(event, ctx, {
      pluginConfig,
      runtimeState,
      logger: api.logger
    });
  });

  api.on("before_compaction", async (event, ctx) => {
    await handleBeforeCompactionObservation(event, ctx, {
      pluginConfig,
      logger: api.logger
    });
  });

  api.on("agent_end", async (event, ctx) => {
    await handleAgentEndHeartbeat(event, ctx, {
      pluginConfig,
      logger: api.logger
    });
  });

  return {
    plugins: {
      slots: {
        memory: memoryManager
      }
    }
  };
}

const clawvaultPlugin = {
  id: "clawvault",
  name: "ClawVault",
  kind: "memory" as const,
  description: "Structured memory system for AI agents with proactive recall and protocol-safe messaging",
  register(apiOrRuntime?: unknown) {
    if (isOpenClawPluginApi(apiOrRuntime)) {
      return registerOpenClawPlugin(apiOrRuntime);
    }

    if (apiOrRuntime && typeof apiOrRuntime === "object") {
      registerMemorySlot(apiOrRuntime as Record<string, unknown>);
    }
    return createMemorySlotPlugin();
  }
};

export default clawvaultPlugin;
export { createMemorySlotPlugin };
