// Jupiter public pricing. The "lite" host is the documented v2 price
// endpoint; the old api.jup.ag host was sunset/returns 404 for most mints.

const PRICE_URL = 'https://lite-api.jup.ag/price/v2';

export async function getPrice(
  mint: string,
): Promise<{ price: number | null; raw: unknown }> {
  const res = await fetch(`${PRICE_URL}?ids=${encodeURIComponent(mint)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`jupiter price ${res.status}`);
  const body = (await res.json()) as {
    data?: Record<string, { price: string | null } | null>;
  };
  const entry = body.data?.[mint] ?? null;
  const price = entry?.price ? Number(entry.price) : null;
  return { price, raw: body };
}
