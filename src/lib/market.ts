// Display data for promoted coins: on-chain metadata via DAS (Helius) + market stats via DexScreener.

export interface CoinInfo {
  mint: string
  name?: string
  symbol?: string
  image?: string
  priceUsd?: number
  marketCap?: number
  liquidityUsd?: number
  volume24h?: number
  change24h?: number
  pairUrl?: string
}

interface DexPair {
  baseToken: { address: string; name: string; symbol: string }
  priceUsd?: string
  marketCap?: number
  fdv?: number
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  priceChange?: { h24?: number }
  url?: string
  info?: { imageUrl?: string }
}

async function fetchDexScreener(mints: string[]) {
  const best = new Map<string, DexPair>()
  for (let i = 0; i < mints.length; i += 30) {
    const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`)
    if (!res.ok) continue
    for (const pair of (await res.json()) as DexPair[]) {
      const mint = pair.baseToken.address
      if (!mints.includes(mint)) continue
      const prev = best.get(mint)
      if (!prev || (pair.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) best.set(mint, pair)
    }
  }
  return best
}

interface DasAsset {
  id: string
  content?: { metadata?: { name?: string; symbol?: string }; links?: { image?: string }; files?: { uri?: string }[] }
}

async function fetchDas(rpc: string, mints: string[]) {
  const out = new Map<string, DasAsset>()
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'cf', method: 'getAssetBatch', params: { ids: mints } }),
  })
  const json = await res.json()
  for (const a of (json.result ?? []) as (DasAsset | null)[]) if (a) out.set(a.id, a)
  return out
}

export async function fetchCoinInfo(rpc: string, mints: string[]): Promise<Record<string, CoinInfo>> {
  if (!mints.length) return {}
  const [dex, das] = await Promise.all([
    fetchDexScreener(mints).catch(() => new Map<string, DexPair>()),
    fetchDas(rpc, mints).catch(() => new Map<string, DasAsset>()), // DAS needs a Helius-style RPC
  ])
  const result: Record<string, CoinInfo> = {}
  for (const mint of mints) {
    const p = dex.get(mint)
    const a = das.get(mint)
    result[mint] = {
      mint,
      name: a?.content?.metadata?.name || p?.baseToken.name,
      symbol: a?.content?.metadata?.symbol || p?.baseToken.symbol,
      image: a?.content?.links?.image || a?.content?.files?.[0]?.uri || p?.info?.imageUrl,
      priceUsd: p?.priceUsd ? Number(p.priceUsd) : undefined,
      marketCap: p?.marketCap ?? p?.fdv,
      liquidityUsd: p?.liquidity?.usd,
      volume24h: p?.volume?.h24,
      change24h: p?.priceChange?.h24,
      pairUrl: p?.url,
    }
  }
  return result
}

export function usd(n?: number) {
  if (n === undefined || !Number.isFinite(n)) return '—'
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toPrecision(3)}`
}
