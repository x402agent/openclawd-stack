import { describe, expect, it } from "vitest";
import { createBeforePromptBuildHandler } from "./before-prompt-build.js";
import { ClawVaultPluginRuntimeState } from "../runtime-state.js";

describe("before_prompt_build hook", () => {
  it("prepends recall policy, recovery/session context, and vault injection", async () => {
    const runtimeState = new ClawVaultPluginRuntimeState();
    runtimeState.setStartupRecoveryNotice("Recovered context from last interrupted run.");
    runtimeState.setSessionRecap("agent:main:direct", "Session recap: user asked for deployment notes.");

    const handler = createBeforePromptBuildHandler({
      pluginConfig: {
        enableBeforePromptRecall: true,
        enforceCommunicationProtocol: true,
        enableSessionContextInjection: true
      },
      runtimeState,
      contextInjector: async () => ({
        prependSystemContext: "Relevant memories:\n- release cutover uses phased waves.",
        memoryEntries: [],
        recapEntries: [],
        vaultPath: "/tmp/vault"
      })
    });

    const result = await handler(
      { prompt: "what did we decide about release?", messages: [] },
      { sessionKey: "agent:main:direct", agentId: "main" }
    );

    expect(result?.prependSystemContext).toContain("ClawVault Memory Recall Policy");
    expect(result?.prependSystemContext).toContain("Recovered context");
    expect(result?.prependSystemContext).toContain("Session recap");
    expect(result?.prependSystemContext).toContain("Relevant memories");
    expect(result?.appendSystemContext).toContain("ClawVault Communication Protocol");
  });

  it("returns void when no injection and protocol disabled", async () => {
    const runtimeState = new ClawVaultPluginRuntimeState();
    const handler = createBeforePromptBuildHandler({
      pluginConfig: {
        enableBeforePromptRecall: false,
        enforceCommunicationProtocol: false,
        enableSessionContextInjection: false
      },
      runtimeState,
      contextInjector: async () => ({
        prependSystemContext: "",
        memoryEntries: [],
        recapEntries: [],
        vaultPath: null
      })
    });

    const result = await handler(
      { prompt: "hello", messages: [] },
      { sessionKey: "agent:main:direct", agentId: "main" }
    );
    expect(result).toBeUndefined();
  });
});
