import { describe, expect, it } from "vitest";
import {
  buildCommunicationProtocolAppendix,
  containsQuestion,
  rewriteOutboundMessage,
  rewriteQuestionWithMemoryEvidence
} from "./communication-protocol.js";

describe("communication protocol", () => {
  it("builds a protocol appendix for system context", () => {
    const appendix = buildCommunicationProtocolAppendix();
    expect(appendix).toContain("ClawVault Communication Protocol");
    expect(appendix).toContain("Never say");
  });

  it("rewrites banned phrases and rabbit-hole offers", () => {
    const input = "Great question — if you'd like I can also explain three alternatives.";
    const rewritten = rewriteOutboundMessage(input);
    expect(rewritten.content.toLowerCase()).not.toContain("great question");
    expect(rewritten.content.toLowerCase()).not.toContain("if you'd like i can");
    expect(rewritten.violations.length).toBeGreaterThan(0);
  });

  it("rewrites question content using memory evidence", () => {
    const output = rewriteQuestionWithMemoryEvidence(
      "Can you remind me what we decided about release cutover?",
      [
        {
          path: "memory/2026-03-10.md",
          startLine: 12,
          endLine: 15,
          score: 0.91,
          snippet: "Decision: release cutover should happen in phased waves.",
          source: "memory",
          citation: "memory/2026-03-10.md#L12-L15"
        }
      ]
    );
    expect(output).toContain("Memory already contains relevant details");
    expect(output).toContain("release cutover");
    expect(output).not.toContain("?");
  });

  it("detects likely outbound questions", () => {
    expect(containsQuestion("Can you share the schedule?")).toBe(true);
    expect(containsQuestion("Here is the schedule.")).toBe(false);
  });
});
