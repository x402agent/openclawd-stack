import type { InboxItem } from '../inbox.js';

const CATEGORY_PATTERNS: Array<{ category: string; patterns: RegExp[] }> = [
  {
    category: 'decisions',
    patterns: [
      /\b(decid(?:e|ed|ing|ion)|chose|selected|opted|trade[- ]?off)\b/i,
      /\b(approved|agreed|consensus)\b/i
    ]
  },
  {
    category: 'lessons',
    patterns: [
      /\b(learn(?:ed|ing|t)|lesson|insight|realized|retrospective)\b/i,
      /\b(next time|note to self|mistake)\b/i
    ]
  },
  {
    category: 'commitments',
    patterns: [
      /\b(todo|task|action item|follow[- ]?up|deadline|due)\b/i,
      /\b(i will|we will|must|need to)\b/i
    ]
  },
  {
    category: 'people',
    patterns: [
      /\b(met with|talked to|spoke with|emailed|called|messaged)\b/i,
      /\b(client|customer|partner|colleague|contact)\b/i
    ]
  },
  {
    category: 'projects',
    patterns: [
      /\b(project|feature|release|deployment|deploy|service|api|repo)\b/i,
      /\b(shipped|launched|merged|rolled out)\b/i
    ]
  },
  {
    category: 'preferences',
    patterns: [
      /\b(prefer(?:s|red|ence)?|like(?:s|d)?|dislike|style|convention)\b/i,
      /\b(always use|never use|default to)\b/i
    ]
  },
  {
    category: 'facts',
    patterns: [
      /\b(is|are|was|were|has|have|contains|includes)\b/i
    ]
  }
];

function splitSentences(content: string): string[] {
  return content
    .split(/\r?\n|(?<=[.?!])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function compactWhitespace(value: string): string {
  return value.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'in', 'on', 'is', 'are', 'was', 'were', 'be',
  'this', 'that', 'it', 'with', 'as', 'at', 'by', 'from', 'we', 'i', 'you', 'they', 'he', 'she'
]);

export function classifyInboxItemHeuristic(item: InboxItem): string {
  const sample = `${item.title}\n${item.content.slice(0, 2400)}`;
  for (const rule of CATEGORY_PATTERNS) {
    if (rule.patterns.some((pattern) => pattern.test(sample))) {
      return rule.category;
    }
  }
  return 'inbox';
}

export function normalizeForDedup(content: string): string {
  return compactWhitespace(content.replace(/\[\[[^\]]+\]\]/g, ''));
}

function wordSet(content: string): Set<string> {
  const words = compactWhitespace(content).split(' ').filter(Boolean);
  const filtered = words.filter((word) => !STOP_WORDS.has(word) && word.length > 2);
  return new Set(filtered);
}

export function similarityScore(left: string, right: string): number {
  const leftWords = wordSet(left);
  const rightWords = wordSet(right);
  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      intersection += 1;
    }
  }
  const union = leftWords.size + rightWords.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function extractHeuristicInsights(content: string): {
  facts: string[];
  decisions: string[];
  lessons: string[];
} {
  const sentences = splitSentences(content);
  const facts = sentences.filter((line) => /\b(is|are|was|were|has|have|contains|includes)\b/i.test(line)).slice(0, 8);
  const decisions = sentences.filter((line) => /\b(decid(?:e|ed|ing|ion)|chose|selected|opted|agreed)\b/i.test(line)).slice(0, 8);
  const lessons = sentences.filter((line) => /\b(learn(?:ed|ing|t)|lesson|insight|realized|next time|mistake)\b/i.test(line)).slice(0, 8);

  if (facts.length === 0 && sentences.length > 0) {
    facts.push(sentences[0]);
  }

  return { facts, decisions, lessons };
}

export function buildHeuristicSurveyRecommendations(params: {
  inboxCount: number;
  linkedRatio: number;
  categoryCounts: Record<string, number>;
}): string[] {
  const recommendations: string[] = [];
  if (params.inboxCount > 20) {
    recommendations.push(`Inbox backlog is high (${params.inboxCount}); run \`clawvault maintain --worker curator\` more frequently.`);
  }
  if (params.linkedRatio < 0.25) {
    recommendations.push('Graph connectivity is low; add wiki-links between related notes to improve context traversal.');
  }
  if ((params.categoryCounts.lessons ?? 0) < 5) {
    recommendations.push('Lessons are sparse; run distillation on long-form captures to keep reusable learnings explicit.');
  }
  if ((params.categoryCounts.decisions ?? 0) < 5) {
    recommendations.push('Decision coverage is light; capture major choices and rationale in decisions/.');
  }
  if (recommendations.length === 0) {
    recommendations.push('Vault health looks balanced. Keep regular maintenance cadence and continue linking related notes.');
  }
  return recommendations;
}
