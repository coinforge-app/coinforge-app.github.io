import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { ago } from '../lib/launches'
import { fetchMintSafety, safetyFlags, usd, type MintSafety } from '../lib/market'
import { useSettings } from '../lib/settings'
import { fetchTrending, type TrendingCoin } from '../lib/trending'
import { CopyButton, errorMessage, short, Status } from '../lib/ui'

const MC_OPTIONS = [10_000, 20_000, 50_000, 100_000, 500_000]
const AGE_OPTIONS = [1, 3, 5, 12, 24]
const SORTS = {
  mc: { label: 'Market cap', fn: (a: TrendingCoin, b: TrendingCoin) => b.marketCap - a.marketCap },
  volume: { label: 'Volume 24h', fn: (a: TrendingCoin, b: TrendingCoin) => b.volume24h - a.volume24h },
  change: { label: 'Change 1h', fn: (a: TrendingCoin, b: TrendingCoin) => b.change1h - a.change1h },
  newest: { label: 'Newest', fn: (a: TrendingCoin, b: TrendingCoin) => b.migratedAt - a.migratedAt },
} as const
type SortKey = keyof typeof SORTS

function Avatar({ coin }: { coin: TrendingCoin }) {
  const [broken, setBroken] = useState(false)
  return coin.image && !broken ? (
    <img className="promo-img" src={coin.image} alt="" onError={() => setBroken(true)} />
  ) : (
    <div className="promo-img ph">{coin.symbol.slice(0, 2)}</div>
  )
}

function pct(n: number) {
  return (
    <span className={n >= 0 ? 'promo-change up' : 'promo-change down'}>
      {n >= 0 ? '▲' : '▼'} {Math.abs(n).toFixed(1)}%
    </span>
  )
}

function TrendingCard({ coin, safety, rank }: { coin: TrendingCoin; safety?: MintSafety; rank: number }) {
  const flags = safetyFlags({ mint: coin.mint, liquidityUsd: coin.liquidity }, safety)
  const total = coin.buys1h + coin.sells1h
  return (
    <div className="card promo-card">
      <div className="promo-top">
        <span className="promo-rank">#{rank}</span>
        <span className="promo-badge">🎓 Migrated {ago(coin.migratedAt)}</span>
        <span className="muted promo-left">{coin.dex === 'pumpswap' ? 'PumpSwap' : 'Raydium'}</span>
      </div>
      <div className="promo-head">
        <Avatar coin={coin} />
        <div className="promo-name">
          <strong>{coin.name}</strong>
          <span className="muted">${coin.symbol.replace(/^\$/, '')}</span>
        </div>
        {pct(coin.change1h)}
      </div>
      <div className="promo-stats">
        <div>
          <span>Market cap</span>
          <strong>{usd(coin.marketCap)}</strong>
        </div>
        <div>
          <span>Liquidity</span>
          <strong>{usd(coin.liquidity)}</strong>
        </div>
        <div>
          <span>Vol 24h</span>
          <strong>{usd(coin.volume24h)}</strong>
        </div>
        <div>
          <span>1h buys / sells</span>
          <strong>
            <span className="ok-text">{coin.buys1h}</span> / <span className="warn-text">{coin.sells1h}</span>
          </strong>
        </div>
      </div>
      {total > 0 && (
        <div className="buy-bar" title={`${Math.round((coin.buys1h / total) * 100)}% buys in the last hour`}>
          <div style={{ width: `${(coin.buys1h / total) * 100}%` }} />
        </div>
      )}
      {flags.length > 0 && (
        <div className="flags">
          {flags.slice(0, 3).map((f) => (
            <span key={f.text} className={`flag ${f.level}`} title={f.title}>
              {f.level === 'ok' ? '✓' : '⚠'} {f.text}
            </span>
          ))}
        </div>
      )}
      <div className="promo-ca">
        <code>{short(coin.mint, 6)}</code> <CopyButton text={coin.mint} />
      </div>
      <div className="row wrap">
        <a className="btn primary sm" href={`https://jup.ag/swap/SOL-${coin.mint}`} target="_blank" rel="noreferrer">
          Buy ↗
        </a>
        <a className="btn ghost sm" href={`https://dexscreener.com/solana/${coin.pool}`} target="_blank" rel="noreferrer">
          Chart ↗
        </a>
        <a className="btn ghost sm" href={`#/promoted?promote=${coin.mint}`}>
          🔥 Promote
        </a>
      </div>
    </div>
  )
}

export default function Trending() {
  const { connection } = useConnection()
  const { network } = useSettings()
  const [coins, setCoins] = useState<TrendingCoin[] | null>(null)
  const [safety, setSafety] = useState<Record<string, MintSafety>>({})
  const [error, setError] = useState('')
  const [minMc, setMinMc] = useState(20_000)
  const [maxAge, setMaxAge] = useState(5)
  const [sort, setSort] = useState<SortKey>('mc')

  const load = useCallback(async () => {
    try {
      setCoins(await fetchTrending())
      setError('')
    } catch (e) {
      setError(errorMessage(e))
      setCoins((c) => c ?? [])
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 120_000)
    return () => clearInterval(id)
  }, [load])

  const visible = useMemo(() => {
    const now = Date.now() / 1000
    return (coins ?? [])
      .filter((c) => c.marketCap >= minMc && now - c.migratedAt <= maxAge * 3600)
      .sort(SORTS[sort].fn)
  }, [coins, minMc, maxAge, sort])

  // Mint/freeze checks straight from chain for the coins on screen
  const visibleKey = visible.map((c) => c.mint).join(',')
  useEffect(() => {
    if (!visibleKey || network !== 'mainnet') return
    fetchMintSafety(connection, visibleKey.split(','))
      .then((s) => setSafety((prev) => ({ ...prev, ...s })))
      .catch(() => {})
  }, [visibleKey, connection, network])

  return (
    <>
      <section className="hero">
        <h1>
          Trending <span className="accent">📈</span>
        </h1>
        <p>Fresh Pump.fun coins that already graduated to a DEX pool — live from GeckoTerminal, refreshed every 2 minutes.</p>
      </section>

      {network !== 'mainnet' && <Status kind="info">Trending shows mainnet coins — switch to Mainnet for live safety checks.</Status>}

      <div className="card trend-filters">
        <label className="field">
          <span>Min. market cap</span>
          <select value={minMc} onChange={(e) => setMinMc(Number(e.target.value))}>
            {MC_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {usd(v)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Migrated within</span>
          <select value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))}>
            {AGE_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v} {v === 1 ? 'hour' : 'hours'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Sort by</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORTS[k].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <Status kind="error">{error}</Status>}

      {coins === null ? (
        <div className="promo-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card promo-card skeleton" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="card empty promo-empty">
          <div className="gate-icon">🔍</div>
          <p>
            No migrated coins above {usd(minMc)} in the last {maxAge}h right now. Try a lower market cap or a longer window.
          </p>
        </div>
      ) : (
        <div className="promo-grid">
          {visible.map((c, i) => (
            <TrendingCard key={c.mint} coin={c} safety={safety[c.mint]} rank={i + 1} />
          ))}
        </div>
      )}

      <div className="card trend-cta">
        <div>
          <strong>Got your own idea?</strong>
          <p className="muted">Launch your coin with its own name and logo in about a minute.</p>
        </div>
        <a className="btn primary" href="#/create">
          🚀 Launch your own coin
        </a>
      </div>

      <p className="hint center promo-disclaimer">
        Market data: GeckoTerminal. Listed coins are not endorsed by CoinForge — most new coins fail. Always DYOR.
      </p>
    </>
  )
}
