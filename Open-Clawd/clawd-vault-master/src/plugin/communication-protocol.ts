import type { MemorySearchResult } from "./memory-types.js";

const BANNED_PHRASE_PATTERNS: Array<{ id: string; regex: RegExp; replacement: string }> = [
  { id: "good-catch", regex: /\bgood catch\b[:,]?\s*/gi, replacement: "" },
  { id: "great-question", regex: /\bgreat question\b[:,]?\s*/gi, replacement: "" },
  { id: "right-to-call-out", regex: /\byou(?:'|’)re right to call that out\b[:,]?\s*/gi, replacement: "" }
];

const RABBIT_HOLE_PATTERNS: RegExp[] = [
  /\bif (?:you(?:'|’)d like|you want(?: me)?(?: to)?|that would help),?\s*i can\b[^.!?]*(?:[.!?]|$)/gi,
  /\blet me know if you(?:'|’)d like\b[^.!?]*(?:[.!?]|$)/gi
];

const QUESTION_OPENERS = /\b(what|why|who|where|when|which|can you|could you|do you|did you|would you|should we)\b/i;

export interface ProtocolRewriteResult {
  content: string;
  violations: string[];
}

export function buildCommunicationProtocolAppendix(): string {
  return [
    "ClawVault Communication Protocol:",
    "- Never say: \"good catch\", \"great question\", or \"you're right to call that out\".",
    "- Never offer rabbit-hole phrasing such as \"if you'd like I can ...\".",
    "- Do not ask questions when memory already contains the answer.",
    "- Use memory tools proactively before answering memory-sensitive prompts."
  ].join("\n");
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function rewriteOutboundMessage(content: string): ProtocolRewriteResult {
  let rewritten = content;
  const violations: string[] = [];

  for (const pattern of BANNED_PHRASE_PATTERNS) {
    if (pattern.regex.test(rewritten)) {
      violations.push(pattern.id);
      rewritten = rewritten.replace(pattern.regex, pattern.replacement);
    }
  }

  for (const regex of RABBIT_HOLE_PATTERNS) {
    if (regex.test(rewritten)) {
      violations.push("rabbit-hole-offer");
      rewritten = rewritten.replace(regex, "");
    }
  }

  rewritten = rewritten
    .replace(/^[,\-:; ]+/, "")
    .replace(/[ ]+([,.!?;:])/g, "$1");
  rewritten = normalizeWhitespace(rewritten);

  if (!rewritten) {
    rewritten = "Understood.";
  }

  return { content: rewritten, violations };
}

export function containsQuestion(content: string): boolean {
  if (!content.includes("?")) return false;
  return QUESTION_OPENERS.test(content.toLowerCase()) || content.trim().endsWith("?");
}

export function rewriteQuestionWithMemoryEvidence(
  originalContent: string,
  memoryHits: MemorySearchResult[]
): string {
  const cleaned = originalContent.replace(/\?/g, ".").replace(/\s+\./g, ".").trim();
  if (memoryHits.length === 0) {
    return cleaned || "Proceeding with the available context.";
  }

  const topHits = memoryHits.slice(0, 2).map((hit) => {
    const citation = hit.citation ? ` (${hit.citation})` : "";
    return `- ${hit.snippet}${citation}`;
  });

  const summary = [
    cleaned || "I checked ClawVault memory before responding.",
    "",
    "Memory already contains relevant details:",
    ...topHits
  ].join("\n");

  return normalizeWhitespace(summary);
}
