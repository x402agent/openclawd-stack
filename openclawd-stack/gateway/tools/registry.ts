// OpenAI-compatible tool schemas + dispatcher. Results are stringified JSON
// so they fit into the `tool` message content the model expects.

import { getSolBalance, getTokenAccounts } from './helius.js';
import { getTokenInfo, getTrendingTokens } from './solana-tracker.js';
import { getPrice } from './jupiter.js';
import { scrapeUrl, searchWeb, mapSite, startCrawl, crawlStatus } from './firecrawl.js';
import type { PaidFetchArgs, PaidFetchResult } from '../payments.js';

/**
 * Session-scoped helpers the dispatcher can call into. Passed in per-request
 * because `pay()` closes over the session's AP2 mandate.
 */
export interface ToolContext {
  pay?: (args: PaidFetchArgs) => Promise<PaidFetchResult>;
  agentUrlForPrivySub?: (sub: string) => string;
}

export const TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_sol_balance',
      description: 'Return the SOL balance of a Solana wallet address.',
      parameters: {
        type: 'object',
        properties: {
          wallet: { type: 'string', description: 'Base58 Solana wallet address.' },
        },
        required: ['wallet'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_token_accounts',
      description:
        "List SPL token balances held by a Solana wallet. Returns [{mint, amount, decimals}].",
      parameters: {
        type: 'object',
        properties: {
          wallet: { type: 'string', description: 'Base58 Solana wallet address.' },
        },
        required: ['wallet'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_token_info',
      description:
        'Return rich metadata + market stats for a Solana token (from solana-tracker). Use for symbol, liquidity, price, holders.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'SPL token mint address.' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_trending_tokens',
      description: 'List trending Solana tokens over a timeframe.',
      parameters: {
        type: 'object',
        properties: {
          timeframe: {
            type: 'string',
            enum: ['5m', '15m', '30m', '1h', '2h', '3h', '4h', '5h', '6h', '12h', '24h'],
            default: '1h',
          },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_token_price',
      description: 'Return the current USD price for a Solana token mint via Jupiter.',
      parameters: {
        type: 'object',
        properties: {
          mint: { type: 'string', description: 'SPL token mint address.' },
        },
        required: ['mint'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_scrape',
      description:
        'Fetch a web page via Firecrawl and return clean markdown + metadata. Use when you need the contents of a specific URL (docs, articles, token pages). Pages are cached for up to an hour upstream.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL to scrape.' },
          screenshot: {
            type: 'boolean',
            description: 'Also return a viewport screenshot URL. Default false.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description:
        'Search the web via Firecrawl and return the top results. Optionally scrape each result to markdown in the same call. Use for open-ended research when you do not know the URL.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          limit: {
            type: 'integer',
            description: 'Number of results (1-10). Default 5.',
            minimum: 1,
            maximum: 10,
          },
          scrape: {
            type: 'boolean',
            description:
              'If true, also return each hit as markdown. More expensive — default false.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_map',
      description:
        'Discover URLs on a website via Firecrawl. Returns up to `limit` links. Useful before a crawl, or to find specific sections (blog, docs, pricing).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Root URL to map.' },
          search: {
            type: 'string',
            description: 'Optional substring to filter returned URLs (e.g. "blog").',
          },
          limit: {
            type: 'integer',
            description: 'Max links to return (1-5000). Default 500.',
            minimum: 1,
            maximum: 5000,
          },
          includeSubdomains: {
            type: 'boolean',
            description: 'Include subdomains. Default false.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_crawl',
      description:
        'Kick off an async crawl of a website via Firecrawl. Returns a crawl `id` immediately. Follow up with `web_crawl_status` to get pages as they complete.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Root URL to crawl.' },
          limit: {
            type: 'integer',
            description: 'Max pages to crawl (1-1000). Default keeps it bounded for cost.',
            minimum: 1,
            maximum: 1000,
          },
          maxDepth: { type: 'integer', description: 'Max link depth from root.' },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only crawl URLs matching these path prefixes.',
          },
          excludePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Skip URLs matching these path prefixes.',
          },
          allowSubdomains: {
            type: 'boolean',
            description: 'Follow links to subdomains. Default false.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_crawl_status',
      description:
        'Check the status of an in-flight crawl job. Returns status (scraping/completed/failed), counters, and the first batch of completed pages as markdown.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Crawl id returned from `web_crawl`.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'call_agent',
      description:
        "Invoke another user's Clawd agent on the network, paying with this session's AP2 USDC mandate. " +
        'Use when a specialist agent (e.g. a DeFi scanner) could answer better than you. Resolves the ' +
        "target either by Privy DID (`privy_sub`) or a direct agent `url`. Returns the remote agent's " +
        'reply body + signature + amount paid.',
      parameters: {
        type: 'object',
        properties: {
          privy_sub: {
            type: 'string',
            description:
              "Privy DID of the target agent's owner (preferred — resolves via on-chain registry).",
          },
          url: {
            type: 'string',
            description: 'Direct agent URL, used when you already have it. Ignored if privy_sub is set.',
          },
          prompt: {
            type: 'string',
            description: 'Text prompt to send to the remote agent.',
          },
          max_usdc: {
            type: 'number',
            description:
              'Single-call cap in USDC (e.g. 0.05). Defaults to the mandate daily cap if omitted.',
          },
        },
        required: ['prompt'],
      },
    },
  },
];

export async function executeToolCall(
  name: string,
  argsJson: string,
  ctx: ToolContext = {},
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch {
    return JSON.stringify({ error: 'invalid_json_args', argsJson });
  }
  try {
    switch (name) {
      case 'get_sol_balance':
        return JSON.stringify(await getSolBalance(String(args.wallet)));
      case 'get_token_accounts':
        return JSON.stringify(await getTokenAccounts(String(args.wallet)));
      case 'get_token_info':
        return JSON.stringify(await getTokenInfo(String(args.mint)));
      case 'get_trending_tokens':
        return JSON.stringify(
          await getTrendingTokens(args.timeframe ? String(args.timeframe) : '1h'),
        );
      case 'get_token_price':
        return JSON.stringify(await getPrice(String(args.mint)));
      case 'web_scrape':
        return JSON.stringify(
          await scrapeUrl(String(args.url), {
            screenshot: Boolean(args.screenshot),
          }),
        );
      case 'web_search':
        return JSON.stringify(
          await searchWeb(String(args.query), {
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            scrape: Boolean(args.scrape),
          }),
        );
      case 'web_map':
        return JSON.stringify(
          await mapSite(String(args.url), {
            search: args.search ? String(args.search) : undefined,
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            includeSubdomains: args.includeSubdomains === true,
          }),
        );
      case 'web_crawl':
        return JSON.stringify(
          await startCrawl(String(args.url), {
            limit: typeof args.limit === 'number' ? args.limit : undefined,
            maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : undefined,
            includePaths: Array.isArray(args.includePaths)
              ? args.includePaths.map(String)
              : undefined,
            excludePaths: Array.isArray(args.excludePaths)
              ? args.excludePaths.map(String)
              : undefined,
            allowSubdomains: args.allowSubdomains === true,
          }),
        );
      case 'web_crawl_status':
        return JSON.stringify(await crawlStatus(String(args.id)));
      case 'call_agent':
        return JSON.stringify(await callAgent(args, ctx));
      default:
        return JSON.stringify({ error: 'unknown_tool', name });
    }
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

/**
 * Pay another agent's URL with this session's AP2 mandate, return their
 * reply + settlement receipt. Resolves `privy_sub` via the injected helper.
 *
 * `max_usdc` caps the single call; the session's mandate independently caps
 * cumulative spend (the vault program rejects any transfer that exceeds it).
 */
async function callAgent(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  if (!ctx.pay) return { error: 'call_agent_unavailable_no_pay_helper' };
  const prompt = String(args.prompt ?? '').slice(0, 32_000);
  if (!prompt) return { error: 'prompt_required' };

  let url: string | null = null;
  const sub = args.privy_sub ? String(args.privy_sub) : null;
  if (sub && ctx.agentUrlForPrivySub) url = ctx.agentUrlForPrivySub(sub);
  if (!url && args.url) url = String(args.url);
  if (!url) return { error: 'privy_sub_or_url_required' };

  let maxAmountBaseUnits: bigint | undefined;
  const maxUsdc = typeof args.max_usdc === 'number' ? args.max_usdc : null;
  if (maxUsdc !== null && Number.isFinite(maxUsdc) && maxUsdc > 0) {
    maxAmountBaseUnits = BigInt(Math.floor(maxUsdc * 1_000_000));
  }

  const result = await ctx.pay({
    url,
    method: 'POST',
    body: JSON.stringify({ prompt }),
    headers: { 'content-type': 'application/json' },
    maxAmountBaseUnits,
  });

  return {
    status: result.status,
    amountPaid: result.amountPaid ?? null,
    asset: result.asset ?? null,
    signature: result.signature ?? null,
    receiptCid: result.receiptCid ?? null,
    // Truncate remote reply so a verbose agent can't blow out our context window.
    reply: result.body.slice(0, 8_000),
  };
}
