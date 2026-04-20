// Helius RPC helpers. Reads HELIUS_RPC_URL or SOLANA_RPC_URL from env.

const RPC_URL =
  process.env.HELIUS_RPC_URL ??
  process.env.SOLANA_RPC_URL ??
  process.env.HELIUS_RPC ??
  'https://api.mainnet-beta.solana.com';

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'clawd', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json()) as { result?: T; error?: { message: string } };
  if (data.error) throw new Error(`RPC ${method}: ${data.error.message}`);
  return data.result as T;
}

export async function getSolBalance(wallet: string): Promise<{ lamports: number; sol: number }> {
  const r = await rpc<{ value: number }>('getBalance', [wallet]);
  return { lamports: r.value, sol: r.value / 1e9 };
}

export async function getTokenAccounts(wallet: string): Promise<
  Array<{ mint: string; amount: number; decimals: number }>
> {
  const r = await rpc<{
    value: Array<{
      account: {
        data: {
          parsed: {
            info: {
              mint: string;
              tokenAmount: { uiAmount: number; decimals: number };
            };
          };
        };
      };
    }>;
  }>('getTokenAccountsByOwner', [
    wallet,
    { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    { encoding: 'jsonParsed' },
  ]);
  return r.value
    .map((a) => {
      const info = a.account.data.parsed.info;
      return {
        mint: info.mint,
        amount: info.tokenAmount.uiAmount,
        decimals: info.tokenAmount.decimals,
      };
    })
    .filter((t) => t.amount > 0);
}
