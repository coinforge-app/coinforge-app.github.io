// Trending tab: Pump.fun coins that already migrated to a DEX pool, from GeckoTerminal's public API.
// GeckoTerminal allows ~30 requests/min per IP, so each load makes 3 requests and caches for 2 minutes.

const GT = 'https://api.geckoterminal.com/api/v2/networks/solana'
const SOURCES = [
  `${GT}/trending_pools?page=1&duration=6h&include=base_token`,
  `${GT}/dexes/pumpswap/pools?page=1&sort=h24_tx_count_desc&include=base_token`,
  `${GT}/dexes/pumpswap/pools?page=2&sort=h24_tx_count_desc&include=base_token`,
]
// Where Pump.fun coins land after graduating (PumpSwap today, Raydium for older migrations)
const MIGRATED_DEXES = new Set(['pumpswap', 'raydium', 'raydium-cpmm'])
const CACHE_KEY = 'cf.trending'
const CACHE_MS = 2 * 60 * 1000

export interface TrendingCoin {
  mint: string
  name: string
  symbol: string
  image?: string
  pool: string
  dex: string
  /** Pool creation = migration time (unix seconds) */
  migratedAt: number
  marketCap: number
  liquidity: number
  volume24h: number
  change1h: number
  change24h: number
  buys1h: number
  sells1h: number
}

interface GtPool {
  attributes: {
    address: string
    name: string
    pool_created_at: string
    fdv_usd: string | null
    market_cap_usd: string | null
    reserve_in_usd: string | null
    volume_usd?: { h24?: string }
    price_change_percentage?: { h1?: string; h24?: string }
    transactions?: { h1?: { buys: number; sells: number } }
  }
  relationships: { base_token: { data: { id: string } }; dex: { data: { id: string } } }
}
interface GtToken {
  id: string
  attributes: { name: string; symbol: string; image_url?: string | null }
}

export class RateLimitedError extends Error {}

async function fetchSource(url: string) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (res.status === 429) throw new RateLimitedError('Data provider rate limit — try again in a minute')
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status}`)
  return (await res.json()) as { data: GtPool[]; included?: GtToken[] }
}

export async function fetchTrending(): Promise<TrendingCoin[]> {
  try {
    const cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || 'null') as { at: number; coins: TrendingCoin[] } | null
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.coins
  } catch {
    /* no cache */
  }

  const byMint = new Map<string, TrendingCoin>()
  let lastError: Error | null = null
  for (const url of SOURCES) {
    let page
    try {
      page = await fetchSource(url)
    } catch (e) {
      lastError = e as Error
      continue
    }
    const tokens = new Map((page.included ?? []).map((t) => [t.id, t.attributes]))
    for (const p of page.data) {
      const a = p.attributes
      const tokenId = p.relationships.base_token.data.id
      const mint = tokenId.replace(/^solana_/, '')
      const dex = p.relationships.dex.data.id
      // Pump.fun mints end in "pump"; only coins that already migrated to a DEX pool
      if (!mint.endsWith('pump') || !MIGRATED_DEXES.has(dex)) continue
      const t = tokens.get(tokenId)
      const coin: TrendingCoin = {
        mint,
        name: t?.name ?? a.name.split(' / ')[0],
        symbol: t?.symbol ?? a.name.split(' / ')[0],
        image: t?.image_url && !t.image_url.includes('missing') ? t.image_url : undefined,
        pool: a.address,
        dex,
        migratedAt: Math.floor(new Date(a.pool_created_at).getTime() / 1000),
        marketCap: Number(a.market_cap_usd ?? a.fdv_usd ?? 0),
        liquidity: Number(a.reserve_in_usd ?? 0),
        volume24h: Number(a.volume_usd?.h24 ?? 0),
        change1h: Number(a.price_change_percentage?.h1 ?? 0),
        change24h: Number(a.price_change_percentage?.h24 ?? 0),
        buys1h: a.transactions?.h1?.buys ?? 0,
        sells1h: a.transactions?.h1?.sells ?? 0,
      }
      const prev = byMint.get(mint)
      if (!prev || coin.liquidity > prev.liquidity) byMint.set(mint, coin)
    }
  }
  if (!byMint.size && lastError) throw lastError

  const coins = [...byMint.values()]
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), coins }))
  } catch {
    /* storage unavailable */
  }
  return coins
}
