import { describe, expect, it, vi } from "vitest";
import clawvaultPlugin from "./openclaw-plugin.js";

describe("openclaw plugin registration", () => {
  it("registers synchronously — no Promise returned", () => {
    const hookNames: string[] = [];
    const registerTool = vi.fn();

    const api = {
      id: "clawvault",
      name: "ClawVault",
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
      },
      pluginConfig: {
        vaultPath: "/tmp/does-not-exist"
      },
      registerTool,
      on: vi.fn((hookName: string) => {
        hookNames.push(hookName);
      })
    };

    const result = clawvaultPlugin.register(api);

    // Critical: OpenClaw discards Promises from register(). Must be sync.
    expect(result).toBeDefined();
    expect(typeof (result as { then?: unknown }).then).not.toBe("function");

    expect(registerTool).toHaveBeenCalledTimes(2);
    expect(hookNames).toContain("before_prompt_build");
    expect(hookNames).toContain("message_sending");
    expect(hookNames).toContain("gateway_start");
    expect(hookNames).toContain("session_start");
    expect(hookNames).toContain("session_end");
    expect(hookNames).toContain("before_reset");
    expect(hookNames).toContain("before_compaction");
    expect(hookNames).toContain("agent_end");

    const memorySlot = (result as { plugins: { slots: { memory: unknown } } }).plugins.slots.memory as {
      search?: unknown;
      readFile?: unknown;
      status?: unknown;
    };
    expect(typeof memorySlot.search).toBe("function");
    expect(typeof memorySlot.readFile).toBe("function");
    expect(typeof memorySlot.status).toBe("function");
  });
});
