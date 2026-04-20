import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { extractFactsRuleBased, type ExtractedFact } from "../lib/fact-extractor.js";
import { FactStore } from "../lib/fact-store.js";

const FACTS_FILE = "facts.jsonl";
const ENTITY_GRAPH_FILE = "entity-graph.json";
const MAX_TEXT_LENGTH = 6_000;

interface EntityGraphNode {
  id: string;
  name: string;
  displayName: string;
  type: string;
  attributes: Record<string, unknown>;
  lastSeen: string;
}

interface EntityGraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  validFrom: string;
  validUntil: string | null;
  confidence: number;
}

function ensureClawVaultDir(vaultPath: string): string {
  const dir = path.join(vaultPath, ".clawvault");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function sanitizeText(value: unknown, maxLength: number = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function collectTextFragments(target: string[], input: unknown, depth: number = 0): void {
  if (depth > 3 || input === null || input === undefined) return;

  if (typeof input === "string") {
    const cleaned = sanitizeText(input);
    if (cleaned) target.push(cleaned);
    return;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      collectTextFragments(target, item, depth + 1);
    }
    return;
  }

  if (typeof input !== "object") return;

  const record = input as Record<string, unknown>;
  const directKeys = ["text", "message", "content", "rawText", "prompt", "observation"];
  for (const key of directKeys) {
    const cleaned = sanitizeText(record[key]);
    if (cleaned) target.push(cleaned);
  }

  const nestedKeys = ["messages", "history", "entries", "items", "events", "payload", "context"];
  for (const key of nestedKeys) {
    collectTextFragments(target, record[key], depth + 1);
  }
}

function dedupeTexts(items: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of items) {
    const cleaned = sanitizeText(item);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    deduped.push(cleaned);
  }
  return deduped;
}

export function collectObservedTextsForFactExtraction(event: unknown): string[] {
  const collected: string[] = [];
  collectTextFragments(collected, event);
  return dedupeTexts(collected);
}

function extractTimestamp(event: unknown): string {
  if (!event || typeof event !== "object") {
    return new Date().toISOString();
  }
  const record = event as Record<string, unknown>;
  const candidates = [
    record.timestamp,
    record.scheduledAt,
    record.time,
    (record.context as Record<string, unknown> | undefined)?.timestamp
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const date = new Date(String(candidate));
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return new Date().toISOString();
}

function buildEntityGraph(facts: ExtractedFact[]): { version: number; nodes: EntityGraphNode[]; edges: EntityGraphEdge[] } {
  const nodes = new Map<string, EntityGraphNode>();
  const edges: EntityGraphEdge[] = [];

  for (const fact of facts) {
    const sourceId = `entity:${fact.entityNorm || fact.entity.toLowerCase()}`;
    const sourceNode: EntityGraphNode = nodes.get(sourceId) ?? {
      id: sourceId,
      name: fact.entityNorm || fact.entity.toLowerCase(),
      displayName: fact.entity,
      type: "person",
      attributes: { entityNorm: fact.entityNorm || fact.entity.toLowerCase() },
      lastSeen: fact.validFrom
    };
    if (new Date(fact.validFrom).getTime() > new Date(sourceNode.lastSeen).getTime()) {
      sourceNode.lastSeen = fact.validFrom;
    }
    nodes.set(sourceId, sourceNode);

    const normalizedValue = fact.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const targetId = `value:${fact.relation}:${normalizedValue || "unknown"}`;
    const targetNode: EntityGraphNode = nodes.get(targetId) ?? {
      id: targetId,
      name: normalizedValue || "unknown",
      displayName: fact.value,
      type: "attribute",
      attributes: { relation: fact.relation },
      lastSeen: fact.validFrom
    };
    if (new Date(fact.validFrom).getTime() > new Date(targetNode.lastSeen).getTime()) {
      targetNode.lastSeen = fact.validFrom;
    }
    nodes.set(targetId, targetNode);

    const edgeHash = createHash("sha1")
      .update(`${fact.id}|${sourceId}|${targetId}|${fact.validFrom}`)
      .digest("hex")
      .slice(0, 18);
    edges.push({
      id: `edge:${edgeHash}`,
      source: sourceId,
      target: targetId,
      relation: fact.relation,
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      confidence: Math.max(0, Math.min(1, fact.confidence ?? 0.7))
    });
  }

  return {
    version: 1,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id))
  };
}

function ensureFactsLogFile(vaultPath: string): void {
  const filePath = path.join(ensureClawVaultDir(vaultPath), FACTS_FILE);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", "utf-8");
  }
}

function persistFactsAndGraph(vaultPath: string, extractedFacts: ExtractedFact[]): {
  extracted: number;
  added: number;
  conflictsResolved: number;
  totalFacts: number;
} {
  ensureFactsLogFile(vaultPath);
  const store = new FactStore(vaultPath);
  store.load();
  const conflictsResolved = store.addFacts(extractedFacts);
  store.save();

  const allFacts = store.getAllFacts();
  const graph = buildEntityGraph(allFacts);
  const graphPath = path.join(ensureClawVaultDir(vaultPath), ENTITY_GRAPH_FILE);
  fs.writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf-8");

  return {
    extracted: extractedFacts.length,
    added: Math.max(0, extractedFacts.length - conflictsResolved),
    conflictsResolved,
    totalFacts: allFacts.length
  };
}

export function runFactExtractionForEvent(vaultPath: string, event: unknown, sourceLabel: string): {
  extracted: number;
  added: number;
  conflictsResolved: number;
  totalFacts: number;
} {
  const observedTexts = collectObservedTextsForFactExtraction(event);
  if (observedTexts.length === 0) {
    return { extracted: 0, added: 0, conflictsResolved: 0, totalFacts: 0 };
  }

  const validFrom = extractTimestamp(event);
  const source = `hook:${sourceLabel}`;
  const facts: ExtractedFact[] = [];

  for (const text of observedTexts) {
    facts.push(...extractFactsRuleBased(text, source, validFrom));
  }

  if (facts.length === 0) {
    return { extracted: 0, added: 0, conflictsResolved: 0, totalFacts: 0 };
  }

  return persistFactsAndGraph(vaultPath, facts);
}
