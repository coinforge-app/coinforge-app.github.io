import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { buildPromoteTx, checkMint, fetchPromotions, isOwner, promotionsEnabled, timeLeft, type Promotion } from '../lib/promote'
import { fetchCoinInfo, fetchMintSafety, safetyFlags, usd, type CoinInfo, type MintSafety } from '../lib/market'
import { explorerUrl, PROMO_HOURS, PROMO_SOL, useSettings } from '../lib/settings'
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
  }))
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
    <div className={promo.featured ? 'card promo-card featured' : 'card promo-card'}>
      <div className="promo-top">
        <span className="promo-rank">#{rank}</span>
        <span className={promo.featured ? 'promo-badge star' : 'promo-badge'}>
          {promo.featured ? '⭐ Featured' : '🔥 Promoted'}
          {promo.boosts > 1 ? ` ×${promo.boosts}` : ''}
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
      const tx = buildPromoteTx(wallet.publicKey, mint, network)
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
          Your coin goes to the top of the CoinForge homepage for {PROMO_HOURS} hours. Paying again extends the time and
          bumps it back to #1.
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
        <div className="summary">
          <div>
            <span>Price</span>
            <strong>{owner ? 'Free (your ad space)' : `${PROMO_SOL} SOL`}</strong>
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
              {!wallet.publicKey ? 'Connect Wallet' : busy ? 'Confirming…' : owner ? 'Promote for free' : `Pay ${PROMO_SOL} SOL & promote`}
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
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<string | null>(() => (hashParam('promote') ? hashParam('promote') : null))

  const load = useCallback(async () => {
    try {
      const list =
        import.meta.env.DEV && location.search.includes('demo') ? demoPromotions() : await fetchPromotions(connection)
      setPromos(list)
      setError('')
      const mints = list.map((p) => p.mint)
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
          Fresh Solana coins, promoted by their creators. Get yours to the top for {PROMO_SOL} SOL · {PROMO_HOURS}h.
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
