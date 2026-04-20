// Firecrawl wrappers — web scrape + search for sandbox agents.
//
// Reads FIRECRAWL_API_KEY at call time so the sandbox can be launched without
// it and still boot. Direct fetch (no SDK dep) to stay consistent with the
// other tool modules in this folder.

const FIRECRAWL_BASE = (process.env.FIRECRAWL_BASE_URL ?? 'https://api.firecrawl.dev').replace(/\/$/, '');

// Replace curly quotes / dashes / non-breaking spaces with ASCII so the
// markdown survives a round-trip through JSON tool results.
function sanitize(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00AB\u00BB]/g, '"')
    .replace(/[\u2039\u203A]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2026]/g, '...')
    .replace(/[\u00A0]/g, ' ');
}

// Cap markdown so a huge page can't blow out the model's context window.
const MAX_MARKDOWN_CHARS = 16_000;

function truncate(text: string, limit = MAX_MARKDOWN_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n…[truncated ${text.length - limit} chars]`;
}

async function firecrawl<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not set');
  const res = await fetch(`${FIRECRAWL_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`firecrawl ${path} ${res.status}: ${err.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface ScrapeResult {
  url: string;
  title: string;
  description: string;
  markdown: string;
  screenshot: string | null;
  cached: boolean;
}

export async function scrapeUrl(
  url: string,
  opts: { screenshot?: boolean; waitMs?: number } = {},
): Promise<ScrapeResult> {
  const formats: string[] = ['markdown'];
  if (opts.screenshot) formats.push('screenshot');

  const data = await firecrawl<{
    success?: boolean;
    data?: {
      markdown?: string;
      metadata?: { title?: string; description?: string };
      screenshot?: string;
      actions?: { screenshots?: string[] };
      cached?: boolean;
    };
  }>('/v1/scrape', {
    url,
    formats,
    waitFor: opts.waitMs ?? 2000,
    timeout: 30_000,
    blockAds: true,
    onlyMainContent: true,
    maxAge: 3_600_000,
  });

  if (!data.success || !data.data) {
    throw new Error('firecrawl scrape returned no data');
  }

  const { markdown = '', metadata = {}, screenshot, actions, cached } = data.data;
  const shot = screenshot ?? actions?.screenshots?.[0] ?? null;

  return {
    url,
    title: sanitize(metadata.title ?? ''),
    description: sanitize(metadata.description ?? ''),
    markdown: truncate(sanitize(markdown)),
    screenshot: shot,
    cached: Boolean(cached),
  };
}

export interface SearchHit {
  url: string;
  title: string;
  description: string;
  markdown: string;
}

export async function searchWeb(
  query: string,
  opts: { limit?: number; scrape?: boolean } = {},
): Promise<SearchHit[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 10));
  const scrape = opts.scrape ?? false;

  const data = await firecrawl<{
    data?: Array<{
      url?: string;
      title?: string;
      description?: string;
      markdown?: string;
    }>;
  }>('/v1/search', {
    query,
    limit,
    ...(scrape
      ? { scrapeOptions: { formats: ['markdown'], onlyMainContent: true } }
      : {}),
  });

  return (data.data ?? []).map((hit) => ({
    url: hit.url ?? '',
    title: sanitize(hit.title ?? hit.url ?? ''),
    description: sanitize(hit.description ?? ''),
    markdown: hit.markdown ? truncate(sanitize(hit.markdown), 4_000) : '',
  }));
}

export interface MapResult {
  url: string;
  count: number;
  links: string[];
}

export async function mapSite(
  url: string,
  opts: { search?: string; limit?: number; includeSubdomains?: boolean } = {},
): Promise<MapResult> {
  const body: Record<string, unknown> = { url };
  if (opts.search) body.search = opts.search;
  if (opts.limit) body.limit = Math.min(Math.max(opts.limit, 1), 5000);
  if (opts.includeSubdomains !== undefined) body.includeSubdomains = opts.includeSubdomains;

  const data = await firecrawl<{ links?: string[] }>('/v1/map', body);
  const links = data.links ?? [];
  return { url, count: links.length, links: links.slice(0, 500) };
}

export interface CrawlStartResult {
  id: string;
  url: string;
}

export async function startCrawl(
  url: string,
  opts: {
    limit?: number;
    maxDepth?: number;
    includePaths?: string[];
    excludePaths?: string[];
    allowSubdomains?: boolean;
  } = {},
): Promise<CrawlStartResult> {
  const body: Record<string, unknown> = { url };
  if (opts.limit) body.limit = Math.min(Math.max(opts.limit, 1), 1000);
  if (opts.maxDepth) body.maxDepth = opts.maxDepth;
  if (opts.includePaths?.length) body.includePaths = opts.includePaths;
  if (opts.excludePaths?.length) body.excludePaths = opts.excludePaths;
  if (opts.allowSubdomains !== undefined) body.allowSubdomains = opts.allowSubdomains;

  const data = await firecrawl<{ success?: boolean; id?: string; url?: string }>(
    '/v1/crawl',
    body,
  );
  if (!data.id) throw new Error('firecrawl crawl returned no id');
  return { id: data.id, url: data.url ?? '' };
}

export interface CrawlStatusPage {
  url: string | null;
  title: string | null;
  markdown: string;
}

export interface CrawlStatusResult {
  id: string;
  status: string;
  completed: number;
  total: number;
  creditsUsed: number | null;
  pages: CrawlStatusPage[];
}

export async function crawlStatus(id: string): Promise<CrawlStatusResult> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not set');
  const res = await fetch(`${FIRECRAWL_BASE}/v1/crawl/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`firecrawl crawl status ${res.status}: ${err.slice(0, 200)}`);
  }
  const body = (await res.json()) as {
    status?: string;
    completed?: number;
    total?: number;
    creditsUsed?: number;
    data?: Array<{
      markdown?: string;
      metadata?: { url?: string; title?: string };
    }>;
  };

  const pages = (body.data ?? []).slice(0, 10).map((p) => ({
    url: p.metadata?.url ?? null,
    title: sanitize(p.metadata?.title ?? '') || null,
    markdown: p.markdown ? truncate(sanitize(p.markdown), 2_500) : '',
  }));

  return {
    id,
    status: body.status ?? 'unknown',
    completed: body.completed ?? 0,
    total: body.total ?? 0,
    creditsUsed: typeof body.creditsUsed === 'number' ? body.creditsUsed : null,
    pages,
  };
}
