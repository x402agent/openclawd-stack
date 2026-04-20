import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ClawVault } from "../lib/vault.js";
import { ClawVaultMemoryManager } from "./memory-manager.js";

const tempDirs: string[] = [];

function makeTempVaultPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawvault-memory-manager-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("ClawVaultMemoryManager", () => {
  it("searches and reads memory files", async () => {
    const vaultPath = makeTempVaultPath();
    fs.mkdirSync(path.join(vaultPath, "memory"), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), "{}\n", "utf-8");
    fs.writeFileSync(
      path.join(vaultPath, "memory", "deployment-plan.md"),
      "# Deployment Plan\n\nWe decided to ship canary releases before global rollout.\n",
      "utf-8"
    );

    const loadSpy = vi.spyOn(ClawVault.prototype, "load").mockResolvedValue(undefined);
    const findSpy = vi.spyOn(ClawVault.prototype, "find").mockResolvedValue([
      {
        document: {
          id: "memory/deployment-plan",
          path: path.join(vaultPath, "memory", "deployment-plan.md"),
          category: "memory",
          title: "deployment-plan",
          content: "We decided to ship canary releases before global rollout.",
          frontmatter: {},
          links: [],
          tags: [],
          modified: new Date()
        },
        score: 0.92,
        snippet: "We decided to ship canary releases before global rollout.",
        matchedTerms: ["canary", "releases"]
      }
    ]);

    const manager = new ClawVaultMemoryManager({
      pluginConfig: { vaultPath }
    });

    const results = await manager.search("canary releases", { maxResults: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet.toLowerCase()).toContain("canary");
    expect(loadSpy).toHaveBeenCalled();
    expect(findSpy).toHaveBeenCalled();

    const fileRead = await manager.readFile({
      relPath: "memory/deployment-plan.md"
    });
    expect(fileRead.text.toLowerCase()).toContain("global rollout");

    const missing = await manager.readFile({
      relPath: "memory/missing.md"
    });
    expect(missing.text).toBe("");
  });

  it("reports provider status and probes availability", async () => {
    const vaultPath = makeTempVaultPath();
    fs.mkdirSync(path.join(vaultPath, "memory"), { recursive: true });
    fs.writeFileSync(path.join(vaultPath, ".clawvault.json"), "{}\n", "utf-8");

    const manager = new ClawVaultMemoryManager({
      pluginConfig: { vaultPath }
    });

    const status = manager.status();
    expect(status.provider).toBe("clawvault");
    expect(status.backend).toBe("builtin");

    const embeddingProbe = await manager.probeEmbeddingAvailability();
    expect(embeddingProbe.ok).toBe(true);

    const vectorProbe = await manager.probeVectorAvailability();
    expect(typeof vectorProbe).toBe("boolean");
  });
});
