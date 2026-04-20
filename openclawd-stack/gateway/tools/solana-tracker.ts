// Solana Tracker API wrappers. Needs SOLANA_TRACKER_API_KEY.
// Docs: https://docs.solanatracker.io/public-data-api

const BASE = process.env.SOLANA_TRACKER_URL ?? 'https://data.solanatracker.io';
const KEY = process.env.SOLANA_TRACKER_API_KEY ?? process.env.SOLANATRACKER_API_KEY ?? '';

async function st<T>(path: string): Promise<T> {
  if (!KEY) throw new Error('SOLANA_TRACKER_API_KEY not configured');
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-api-key': KEY },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`solana-tracker ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function getTokenInfo(mint: string): Promise<unknown> {
  return st(`/tokens/${mint}`);
}

export async function getTrendingTokens(timeframe: string = '1h'): Promise<unknown> {
  return st(`/tokens/trending/${timeframe}`);
}
