import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClawVaultPluginRuntimeState } from "../runtime-state.js";

const { recoverMock, checkpointMock, flushCheckpointMock, runReflectionMock } = vi.hoisted(() => ({
  recoverMock: vi.fn(),
  checkpointMock: vi.fn(),
  flushCheckpointMock: vi.fn(),
  runReflectionMock: vi.fn()
}));

vi.mock("../../commands/recover.js", () => ({
  recover: recoverMock
}));

vi.mock("../../commands/checkpoint.js", () => ({
  checkpoint: checkpointMock,
  flush: flushCheckpointMock
}));

vi.mock("../../observer/reflection-service.js", () => ({
  runReflection: runReflectionMock
}));

import { handleBeforeReset, handleGatewayStart } from "./session-lifecycle.js";

describe("session lifecycle hooks", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    recoverMock.mockReset();
    checkpointMock.mockReset();
    flushCheckpointMock.mockReset();
    runReflectionMock.mockReset();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempVault(): string {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "clawvault-session-lifecycle-"));
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), JSON.stringify({ name: "session-lifecycle-test" }), "utf-8");
    tempDirs.push(vaultPath);
    return vaultPath;
  }

  it("hydrates startup recovery notice via in-process recover()", async () => {
    const runtimeState = new ClawVaultPluginRuntimeState();
    const vaultPath = createTempVault();
    recoverMock.mockResolvedValue({
      died: true,
      deathTime: "2026-03-16T00:00:00.000Z",
      checkpoint: { timestamp: "2026-03-16T00:00:00.000Z", workingOn: "Deploy canary" },
      handoffPath: null,
      handoffContent: null,
      recoveryMessage: "Context death"
    });

    await handleGatewayStart(
      { port: 3377 },
      {},
      {
        pluginConfig: { enableStartupRecovery: true, vaultPath },
        runtimeState,
        logger: { info: () => undefined, warn: () => undefined }
      }
    );

    expect(recoverMock).toHaveBeenCalledWith(vaultPath, { clearFlag: true });
    const notice = runtimeState.consumeStartupRecoveryNotice();
    expect(notice).toContain("Context death detected");
    expect(notice).toContain("Deploy canary");
  });

  it("writes auto-checkpoint before reset via in-process checkpoint()", async () => {
    const runtimeState = new ClawVaultPluginRuntimeState();
    const vaultPath = createTempVault();
    checkpointMock.mockResolvedValue({
      timestamp: "2026-03-16T00:00:00.000Z",
      workingOn: "Session reset via test_reset",
      focus: "Pre-reset checkpoint",
      blocked: null
    });
    flushCheckpointMock.mockResolvedValue(null);

    await handleBeforeReset(
      {
        reason: "test_reset",
        messages: []
      },
      {
        sessionKey: "agent:main:session-5",
        agentId: "main",
        workspaceDir: vaultPath
      },
      {
        pluginConfig: {
          enableAutoCheckpoint: true,
          enableObserveOnNew: false,
          enableFactExtraction: false,
          vaultPath
        },
        runtimeState,
        logger: { info: () => undefined, warn: () => undefined }
      }
    );

    expect(checkpointMock).toHaveBeenCalledWith({
      workingOn: "Session reset via test_reset",
      focus: "Pre-reset checkpoint, session: agent:main:session-5",
      vaultPath
    });
    expect(flushCheckpointMock).toHaveBeenCalledTimes(1);
  });
});
