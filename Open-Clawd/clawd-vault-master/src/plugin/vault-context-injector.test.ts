import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { buildSessionRecapMock, loadMock, findMock, ClawVaultMock } = vi.hoisted(() => ({
  buildSessionRecapMock: vi.fn(),
  loadMock: vi.fn(),
  findMock: vi.fn(),
  ClawVaultMock: vi.fn()
}));

vi.mock("../commands/session-recap.js", () => ({
  buildSessionRecap: buildSessionRecapMock
}));

vi.mock("../lib/vault.js", () => ({
  ClawVault: ClawVaultMock
}));

import { fetchMemoryContextEntries, fetchSessionRecapEntries } from "./vault-context-injector.js";

describe("vault context injector", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    loadMock.mockReset();
    findMock.mockReset();
    ClawVaultMock.mockReset();
    ClawVaultMock.mockImplementation(() => ({
      load: loadMock,
      find: findMock
    }));
    buildSessionRecapMock.mockReset();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function createTempVault(): string {
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "clawvault-injector-"));
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), JSON.stringify({ name: "injector-test" }), "utf-8");
    tempDirs.push(vaultPath);
    return vaultPath;
  }

  it("uses in-process ClawVault.find for memory context entries", async () => {
    const vaultPath = createTempVault();
    findMock.mockResolvedValue([
      {
        document: {
          id: "decisions/release-plan",
          path: path.join(vaultPath, "decisions", "release-plan.md"),
          category: "decisions",
          title: "Release plan",
          content: "Canary first, then global rollout.",
          frontmatter: {},
          links: [],
          tags: [],
          modified: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
        },
        score: 0.91,
        snippet: "Decision: Canary first, then global rollout.",
        matchedTerms: ["canary", "rollout"]
      }
    ]);

    const result = await fetchMemoryContextEntries({
      prompt: " What release rollout did we choose? ",
      pluginConfig: { vaultPath },
      maxResults: 5
    });

    expect(ClawVaultMock).toHaveBeenCalledWith(vaultPath);
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(findMock).toHaveBeenCalledWith("What release rollout did we choose?", {
      limit: 5,
      minScore: 0.2,
      temporalBoost: true
    });
    expect(result.vaultPath).toBe(vaultPath);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.title).toBe("Release plan");
    expect(result.entries[0]?.path).toBe("decisions/release-plan.md");
    expect(result.entries[0]?.snippet).toContain("Canary first");
  });

  it("maps recap messages via buildSessionRecap", async () => {
    buildSessionRecapMock.mockResolvedValue({
      messages: [
        { role: "user", text: "Please summarize deployment status." },
        { role: "assistant", text: "Deployment is in canary phase." }
      ]
    });

    const entries = await fetchSessionRecapEntries({
      sessionKey: "agent:main:session-42",
      agentId: "main",
      pluginConfig: {}
    });

    expect(buildSessionRecapMock).toHaveBeenCalledWith("agent:main:session-42", {
      agentId: "main",
      limit: 6
    });
    expect(entries).toEqual([
      { role: "User", text: "Please summarize deployment status." },
      { role: "Assistant", text: "Deployment is in canary phase." }
    ]);
  });
});
