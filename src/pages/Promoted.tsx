import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import {
  buildPromoteTx,
  checkMint,
  fetchPromotions,
  isOwner,
  promotionsEnabled,
  TIERS,
  timeLeft,
  type Promotion,
  type TierId,
} from '../lib/promote'
import { ago, fetchLaunches, type Launch } from '../lib/launches'
import { fetchCoinInfo, fetchMintSafety, safetyFlags, usd, type CoinInfo, type MintSafety } from '../lib/market'
import { explorerUrl, LAUNCH_HOURS, PROMO_HOURS, PROMO_SOL, REF_PERCENT, useSettings } from '../lib/settings'
import { getReferrer } from '../lib/referral'
import { getTokens } from '../lib/storage'
import { CopyButton, errorMessage, short, Status } from '../lib/ui'

/** Dev-only preview (`npm run dev`, then open /?demo) with real mainnet coins as fake promotions. */
function demoPromotions(): Promotion[] {
  const now = Math.floor(Date.now() / 1000)
  const mints = [
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  ]
  return mints.map((mint, i) => ({
    mint,
    signature: '',
    paidAt: now - i * 3600,
    expiresAt: now + (20 - i * 5) * 3600,
    boosts: i === 1 ? 2 : 1,
    featured: i === 2,
    tier: (['top', 'boost', 'basic'] as TierId[])[i],
    points: [10, 6, 1][i],
  }))
}

function demoLaunches(): Launch[] {
  const now = Math.floor(Date.now() / 1000)
  return [
    { mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump', creator: '', createdAt: now - 4 * 60, signature: '' },
    { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', creator: '', createdAt: now - 52 * 60, signature: '' },
    { mint: 'A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump', creator: '', createdAt: now - 3 * 3600, signature: '' },
  ]
}

function hashParam(name: string) {
  return new URLSearchParams(window.location.hash.split('?')[1] || '').get(name) || ''
}

function CoinAvatar({ info }: { info?: CoinInfo }) {
  const [broken, setBroken] = useState(false)
  return info?.image && !broken ? (
    <img className="promo-img" src={info.image} alt="" onError={() => setBroken(true)} />
  ) : (
    <div className="promo-img ph">{(info?.symbol || '?').slice(0, 2)}</div>
  )
}

function SafetyFlags({ info, safety }: { info?: CoinInfo; safety?: MintSafety }) {
  const flags = safetyFlags(info, safety)
  if (!flags.length) return null
  return (
    <div className="flags">
      {flags.map((f) => (
        <span key={f.text} className={`flag ${f.level}`} title={f.title}>
          {f.level === 'ok' ? '✓' : '⚠'} {f.text}
        </span>
      ))}
    </div>
  )
}

function PromoCard({ promo, info, safety, rank }: { promo: Promotion; info?: CoinInfo; safety?: MintSafety; rank: number }) {
  const { network } = useSettings()
  const change = info?.change24h
  return (
    <div className={`card promo-card tier-${promo.tier}${promo.featured ? ' featured' : ''}`}>
      <div className="promo-top">
        <span className="promo-rank">#{rank}</span>
        <span className={`promo-badge ${promo.tier}`} title={promo.featured ? 'Featured by CoinForge' : undefined}>
          {TIERS[promo.tier].badge}
          {promo.boosts > 1 ? ` ×${promo.boosts}` : ''}
          {promo.featured ? ' · ⭐' : ''}
        </span>
        <span className="muted promo-left">{timeLeft(promo.expiresAt)}</span>
      </div>
      <div className="promo-head">
        <CoinAvatar info={info} />
        <div className="promo-name">
          <strong>{info?.name || short(promo.mint, 6)}</strong>
          <span className="muted">{info?.symbol ? `$${info.symbol.replace(/^\$/, '')}` : 'Loading…'}</span>
        </div>
        {change !== undefined && (
          <span className={change >= 0 ? 'promo-change up' : 'promo-change down'}>
            {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}%
          </span>
        )}
      </div>
      <div className="promo-stats">
        <div>
          <span>Market cap</span>
          <strong>{usd(info?.marketCap)}</strong>
        </div>
        <div>
          <span>Price</span>
          <strong>{usd(info?.priceUsd)}</strong>
        </div>
        <div>
          <span>Liquidity</span>
          <strong>{usd(info?.liquidityUsd)}</strong>
        </div>
        <div>
          <span>Vol 24h</span>
          <strong>{usd(info?.volume24h)}</strong>
        </div>
      </div>
      <SafetyFlags info={info} safety={safety} />
      <div className="promo-ca">
        <code>{short(promo.mint, 6)}</code> <CopyButton text={promo.mint} />
      </div>
      <div className="row wrap">
        {network === 'mainnet' && (
          <a className="btn primary sm" href={`https://jup.ag/swap/SOL-${promo.mint}`} target="_blank" rel="noreferrer">
            Buy ↗
          </a>
        )}
        <a
          className="btn ghost sm"
          href={info?.pairUrl || `https://dexscreener.com/solana/${promo.mint}`}
          target="_blank"
          rel="noreferrer"
        >
          Chart ↗
        </a>
        <a className="btn ghost sm" href={explorerUrl('token', promo.mint, network)} target="_blank" rel="noreferrer">
          Solscan ↗
        </a>
      </div>
    </div>
  )
}

function LaunchCard({ launch, info, safety, onBoost }: {
  launch: Launch
  info?: CoinInfo
  safety?: MintSafety
  onBoost: () => void
}) {
  const flags = safetyFlags(info, safety).filter((f) => f.level !== 'warn' || f.text === 'No pool')
  return (
    <div className="card launch-card">
      <div className="launch-head">
        <CoinAvatar info={info} />
        <div className="promo-name">
          <strong>{info?.name || short(launch.mint, 4)}</strong>
          <span className="muted">{info?.symbol ? `$${info.symbol.replace(/^\$/, '')}` : '…'}</span>
        </div>
        <span className="launch-age">{ago(launch.createdAt)}</span>
      </div>
      <div className="launch-mc">
        <span>MC</span>
        <strong>{info?.marketCap ? usd(info.marketCap) : 'No pool yet'}</strong>
      </div>
      {flags.length > 0 && (
        <div className="flags">
          {flags.slice(0, 2).map((f) => (
            <span key={f.text} className={`flag ${f.level}`} title={f.title}>
              {f.level === 'ok' ? '✓' : '⚠'} {f.text}
            </span>
          ))}
        </div>
      )}
      <div className="row">
        <a className="btn ghost sm" href={info?.pairUrl || `https://dexscreener.com/solana/${launch.mint}`} target="_blank" rel="noreferrer">
          Chart ↗
        </a>
        <button className="btn primary sm" onClick={onBoost}>
          🔥 Boost
        </button>
      </div>
    </div>
  )
}

function PromoteDialog({ initialMint, onClose, onPromoted }: {
  initialMint: string
  onClose: () => void
  onPromoted: (mint: string) => void
}) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const { setVisible } = useWalletModal()
  const { network, rpc } = useSettings()
  const owner = isOwner(wallet.publicKey)
  const myTokens = useMemo(() => (wallet.publicKey ? getTokens(wallet.publicKey.toBase58(), network) : []), [wallet.publicKey, network])
  const [mint, setMint] = useState(initialMint || myTokens[0]?.mint || '')
  const [tier, setTier] = useState<TierId>('boost')
  const [preview, setPreview] = useState<CoinInfo | null>(null)
  const [previewSafety, setPreviewSafety] = useState<MintSafety | undefined>()
  const [mintError, setMintError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  useEffect(() => {
    setPreview(null)
    setMintError('')
    if (mint.length < 32) return
    let cancelled = false
    checkMint(connection, mint)
      .then(() => Promise.all([fetchCoinInfo(rpc, [mint]), fetchMintSafety(connection, [mint])]))
      .then(([info, safety]) => {
        if (cancelled) return
        setPreview(info[mint])
        setPreviewSafety(safety[mint])
      })
      .catch((e) => !cancelled && setMintError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [mint, connection, rpc])

  const submit = async () => {
    if (!wallet.publicKey) return setVisible(true)
    setBusy(true)
    setError('')
    try {
      const tx = buildPromoteTx(wallet.publicKey, mint, network, getReferrer(wallet.publicKey), tier)
      const latest = await connection.getLatestBlockhash('confirmed')
      tx.recentBlockhash = latest.blockhash
      tx.feePayer = wallet.publicKey
      const sig = await wallet.sendTransaction(tx, connection)
      await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed')
      setDone(sig)
      onPromoted(mint)
    } catch (e) {
      console.error(e)
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h3>🔥 Promote your coin</h3>
        <p className="hint">
          Your coin is listed on the CoinForge homepage for {PROMO_HOURS} hours. Higher tiers rank higher; paying again
          extends the time and stacks your boost.
        </p>
        <label className="field">
          <span>Token mint address</span>
          <div className="input-row">
            <input placeholder="Paste any Solana token mint" value={mint} onChange={(e) => setMint(e.target.value.trim())} />
            {myTokens.length > 0 && (
              <select value="" onChange={(e) => e.target.value && setMint(e.target.value)} aria-label="Pick one of your tokens">
                <option value="">My tokens…</option>
                {myTokens.map((t) => (
                  <option key={t.mint} value={t.mint}>
                    {t.symbol} · {short(t.mint)}
                  </option>
                ))}
              </select>
            )}
          </div>
        </label>
        {mintError && <p className="warn-text">{mintError}</p>}
        {preview && <SafetyFlags info={preview} safety={previewSafety} />}
        {preview && (
          <div className="promo-preview">
            <CoinAvatar info={preview} />
            <div>
              <strong>{preview.name || short(mint, 6)}</strong>
              <div className="muted">
                {preview.symbol ? `$${preview.symbol.replace(/^\$/, '')}` : ''} {preview.marketCap ? `· MC ${usd(preview.marketCap)}` : '· no pool yet'}
              </div>
            </div>
          </div>
        )}
        <div className="tier-grid">
          {(Object.keys(TIERS) as TierId[]).map((t) => (
            <button key={t} className={`tier-option ${t}${tier === t ? ' selected' : ''}`} onClick={() => setTier(t)}>
              <span className="tier-name">{TIERS[t].badge}</span>
              <strong>{owner ? 'Free' : `${TIERS[t].sol} SOL`}</strong>
              <small>{TIERS[t].perk}</small>
            </button>
          ))}
        </div>
        <div className="summary">
          <div>
            <span>Price</span>
            <strong>{owner ? 'Free (your ad space)' : `${TIERS[tier].sol} SOL`}</strong>
            {!owner && getReferrer(wallet.publicKey) && <small className="ok-text">🤝 {REF_PERCENT}% to your referrer</small>}
          </div>
          <div>
            <span>Duration</span>
            <strong>{PROMO_HOURS} hours</strong>
          </div>
          <div>
            <span>Network</span>
            <strong className={network === 'mainnet' ? '' : 'warn-text'}>{network === 'mainnet' ? 'Mainnet' : 'Devnet'}</strong>
          </div>
        </div>
        {error && <Status kind="error">{error}</Status>}
        {done ? (
          <>
            <Status kind="success">
              Promoted! It shows up at the top within a few seconds ·{' '}
              <a href={explorerUrl('tx', done, network)} target="_blank" rel="noreferrer">
                Transaction ↗
              </a>
            </Status>
            <div className="row end">
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <div className="row end">
            <button className="btn ghost" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || (!!wallet.publicKey && !preview)} onClick={submit}>
              {!wallet.publicKey ? 'Connect Wallet' : busy ? 'Confirming…' : owner ? 'Promote for free' : `Pay ${TIERS[tier].sol} SOL & promote`}
            </button>
          </div>
        )}
        <p className="hint">Promotions are paid ads, not endorsements. Fees are non-refundable.</p>
      </div>
    </div>
  )
}

export default function Promoted() {
  const { connection } = useConnection()
  const { rpc, network } = useSettings()
  const [promos, setPromos] = useState<Promotion[] | null>(null)
  const [coins, setCoins] = useState<Record<string, CoinInfo>>({})
  const [safety, setSafety] = useState<Record<string, MintSafety>>({})
  const [launches, setLaunches] = useState<Launch[] | null>(null)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<string | null>(() => (hashParam('promote') ? hashParam('promote') : null))

  const load = useCallback(async () => {
    try {
      const demo = import.meta.env.DEV && location.search.includes('demo')
      const [list, fresh] = await Promise.all([
        demo ? demoPromotions() : fetchPromotions(connection),
        demo ? demoLaunches() : fetchLaunches(connection).catch(() => [] as Launch[]),
      ])
      setPromos(list)
      setLaunches(fresh)
      setError('')
      const mints = [...new Set([...list.map((p) => p.mint), ...fresh.map((l) => l.mint)])]
      const [info, checks] = await Promise.all([fetchCoinInfo(rpc, mints), fetchMintSafety(connection, mints).catch(() => ({}))])
      setCoins(info)
      setSafety(checks)
    } catch (e) {
      setError(errorMessage(e))
      setPromos((p) => p ?? [])
    }
  }, [connection, rpc])

  useEffect(() => {
    setPromos(null)
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  return (
    <>
      <section className="hero">
        <h1>
          Promoted Memecoins <span className="accent">🔥</span>
        </h1>
        <p>
          Fresh Solana coins, promoted by their creators. Get listed from {PROMO_SOL} SOL · {PROMO_HOURS}h — or grab the 👑 Top Spot.
        </p>
        <div className="row center wrap hero-actions">
          <button className="btn primary" disabled={!promotionsEnabled()} onClick={() => setDialog('')}>
            🔥 Promote your coin
          </button>
          <a className="btn ghost" href="#/create">
            Create a coin
          </a>
        </div>
      </section>

      {!promotionsEnabled() && <Status kind="info">Promotions are not configured on this instance (no fee wallet).</Status>}
      {error && <Status kind="error">Could not load promotions: {error}</Status>}

      <div className="launch-section">
        <div className="launch-title">
          <h3>🆕 Just launched</h3>
          <span className="muted">New coins from CoinForge · free for {LAUNCH_HOURS}h</span>
        </div>
        {launches === null ? (
          <div className="launch-strip">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card launch-card skeleton" />
            ))}
          </div>
        ) : launches.length === 0 ? (
          <p className="hint">
            No new launches in the last {LAUNCH_HOURS} hours — <a href="#/create">create the next one</a> and it shows up here
            for free.
          </p>
        ) : (
          <div className="launch-strip">
            {launches.map((l) => (
              <LaunchCard key={l.mint} launch={l} info={coins[l.mint]} safety={safety[l.mint]} onBoost={() => setDialog(l.mint)} />
            ))}
          </div>
        )}
      </div>

      <h3 className="promo-section-title">🔥 Promoted</h3>
      {promos === null ? (
        <div className="promo-grid">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card promo-card skeleton" />
          ))}
        </div>
      ) : promos.length === 0 ? (
        <div className="card empty promo-empty">
          <div className="gate-icon">🚀</div>
          <p>No promoted coins on {network} right now — be the first at the top.</p>
          <button className="btn primary" disabled={!promotionsEnabled()} onClick={() => setDialog('')}>
            Promote your coin for {PROMO_SOL} SOL
          </button>
        </div>
      ) : (
        <div className="promo-grid">
          {promos.map((p, i) => (
            <PromoCard key={p.mint} promo={p} info={coins[p.mint]} safety={safety[p.mint]} rank={i + 1} />
          ))}
        </div>
      )}

      <p className="hint center promo-disclaimer">
        Promoted listings are paid placements by third parties, not endorsements or financial advice. Always DYOR.
      </p>

      {dialog !== null && (
        <PromoteDialog
          initialMint={dialog}
          onClose={() => {
            setDialog(null)
            if (hashParam('promote')) history.replaceState(null, '', '#/promoted')
          }}
          onPromoted={() => setTimeout(load, 4000)}
        />
      )}
    </>
  )
}
