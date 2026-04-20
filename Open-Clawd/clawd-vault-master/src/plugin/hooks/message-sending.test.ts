import { describe, expect, it } from "vitest";
import { createMessageSendingHandler } from "./message-sending.js";
import type { MemorySearchManager } from "../memory-types.js";

function createMemoryManager(results: Array<{ snippet: string; citation?: string }>): MemorySearchManager {
  return {
    async search() {
      return results.map((result, index) => ({
        path: `memory/test-${index}.md`,
        startLine: 1,
        endLine: 3,
        score: 0.9,
        snippet: result.snippet,
        source: "memory" as const,
        citation: result.citation
      }));
    },
    async readFile() {
      return { text: "", path: "" };
    },
    status() {
      return { backend: "builtin", provider: "test" };
    },
    async probeEmbeddingAvailability() {
      return { ok: true };
    },
    async probeVectorAvailability() {
      return false;
    }
  };
}

describe("message_sending hook", () => {
  it("rewrites banned communication patterns", async () => {
    const handler = createMessageSendingHandler({
      pluginConfig: {
        enableMessageSendingFilter: true
      },
      memoryManager: createMemoryManager([])
    });

    const result = await handler(
      {
        to: "user-1",
        content: "Good catch. If you'd like I can provide another angle."
      },
      { channelId: "direct" }
    );

    expect(result?.content?.toLowerCase()).not.toContain("good catch");
    expect(result?.content?.toLowerCase()).not.toContain("if you'd like i can");
  });

  it("prevents outbound questions when memory already has answers", async () => {
    const handler = createMessageSendingHandler({
      pluginConfig: {
        enableMessageSendingFilter: true,
        minQuestionRecallScore: 0.2
      },
      memoryManager: createMemoryManager([
        {
          snippet: "Decision: launch canary rollout first, then global rollout."
        }
      ])
    });

    const result = await handler(
      {
        to: "user-2",
        content: "Can you remind me what rollout sequence we picked?"
      },
      { channelId: "direct" }
    );

    expect(result?.content).toContain("Memory already contains relevant details");
    expect(result?.content).not.toContain("?");
  });
});
