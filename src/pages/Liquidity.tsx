import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import type { ApiCpmmConfigInfo, Raydium } from '@raydium-io/raydium-sdk-v2'
import Decimal from 'decimal.js'
import {
  createPool,
  findPoolsForMint,
  fromRaw,
  getFeeConfigs,
  getLpBalance,
  getMintInfo,
  getPool,
  removeLiquidity,
  WSOL_MINT,
} from '../lib/raydium'
import { explorerUrl, useSettings, type Network } from '../lib/settings'
import { addPool, getPools, getTokens, removePool, type PoolRecord } from '../lib/storage'
import { ConnectGate, CopyButton, errorMessage, short, Status } from '../lib/ui'
import { useRaydium } from '../lib/useRaydium'

type MintInfo = Awaited<ReturnType<typeof getMintInfo>>

function hashParam(name: string) {
  return new URLSearchParams(window.location.hash.split('?')[1] || '').get(name) || ''
}

function fmt(n: number | string, max = 6) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '—'
  if (v !== 0 && Math.abs(v) < 1e-6) return v.toExponential(3)
  return v.toLocaleString('en-US', { maximumFractionDigits: max })
}

function CreatePoolCard({ raydium, onCreated }: { raydium: Raydium; onCreated: () => void }) {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  const { network } = useSettings()
  const owner = publicKey!.toBase58()
  const myTokens = useMemo(() => getTokens(owner, network), [owner, network])

  const [mint, setMint] = useState(() => hashParam('mint') || myTokens[0]?.mint || '')
  const [info, setInfo] = useState<MintInfo | null>(null)
  const [balance, setBalance] = useState<string>('0')
  const [solBalance, setSolBalance] = useState(0)
  const [tokenAmount, setTokenAmount] = useState('')
  const [solAmount, setSolAmount] = useState('')
  const [configs, setConfigs] = useState<ApiCpmmConfigInfo[]>([])
  const [configId, setConfigId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ poolId: string; txId: string } | null>(null)

  useEffect(() => {
    getFeeConfigs(raydium, network)
      .then((c) => {
        setConfigs(c)
        setConfigId((c.find((x) => x.tradeFeeRate === 2500) || c[0])?.id || '')
      })
      .catch((e) => setError(`Could not load Raydium fee tiers: ${errorMessage(e)}`))
  }, [raydium, network])

  useEffect(() => {
    connection.getBalance(publicKey!).then((l) => setSolBalance(l / 1e9)).catch(() => {})
  }, [connection, publicKey, done])

  useEffect(() => {
    setInfo(null)
    setError('')
    let valid = false
    try {
      new PublicKey(mint)
      valid = mint.length >= 32
    } catch {
      /* not an address yet */
    }
    if (!valid) return
    let cancelled = false
    getMintInfo(connection, mint)
      .then(async (i) => {
        if (cancelled) return
        setInfo(i)
        const accts = await connection.getParsedTokenAccountsByOwner(publicKey!, { mint: new PublicKey(mint) })
        const raw = accts.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n)
        if (!cancelled) setBalance(fromRaw(raw.toString(), i.decimals))
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [mint, connection, publicKey])

  const config = configs.find((c) => c.id === configId)
  const price = useMemo(() => {
    try {
      const t = new Decimal(tokenAmount || 0)
      const s = new Decimal(solAmount || 0)
      return t.gt(0) && s.gt(0) ? s.div(t) : null
    } catch {
      return null
    }
  }, [tokenAmount, solAmount])
  const supplyHuman = info ? Number(fromRaw(info.supply, info.decimals)) : 0
  const createFee = config ? Number(config.createPoolFee) / 1e9 : 0
  const knownSymbol = myTokens.find((t) => t.mint === mint)?.symbol

  const submit = async () => {
    if (!config || !info) return
    setBusy(true)
    setError('')
    try {
      const res = await createPool(raydium, connection, network, { tokenMint: mint, tokenAmount, solAmount, feeConfig: config })
      addPool({
        poolId: res.poolId,
        lpMint: res.lpMint,
        mintA: res.mintA,
        mintB: res.mintB,
        creator: owner,
        network,
        signature: res.txId,
        createdAt: Date.now(),
      })
      setDone({ poolId: res.poolId, txId: res.txId })
      onCreated()
    } catch (e) {
      console.error(e)
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const insufficient =
    (info && tokenAmount && new Decimal(tokenAmount || 0).gt(balance)) ||
    (solAmount && Number(solAmount) + createFee + 0.01 > solBalance)

  return (
    <div className="card">
      <h3>Create Raydium Pool (Token / SOL)</h3>
      <label className="field">
        <span>Token mint address</span>
        <div className="input-row">
          <input placeholder="Paste token mint address" value={mint} onChange={(e) => setMint(e.target.value.trim())} />
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

      {info && (
        <div className="token-meta">
          <span>Decimals: {info.decimals}</span>
          <span>Supply: {fmt(supplyHuman, 2)}</span>
          <span>Your balance: {fmt(balance, 4)}</span>
          <span className={info.mintAuthority ? 'warn-text' : 'ok-text'}>
            Mint auth: {info.mintAuthority ? 'active' : 'revoked'}
          </span>
          <span className={info.freezeAuthority ? 'warn-text' : 'ok-text'}>
            Freeze auth: {info.freezeAuthority ? 'active' : 'revoked'}
          </span>
        </div>
      )}

      <div className="grid2">
        <label className="field">
          <span>
            {knownSymbol || 'Token'} amount
            {info && (
              <span className="pct">
                {[25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    onClick={() =>
                      setTokenAmount(new Decimal(balance).mul(p).div(100).toDecimalPlaces(info.decimals, Decimal.ROUND_DOWN).toString())
                    }
                  >
                    {p === 100 ? 'MAX' : `${p}%`}
                  </button>
                ))}
              </span>
            )}
          </span>
          <input inputMode="decimal" placeholder="0" value={tokenAmount} onChange={(e) => setTokenAmount(e.target.value)} />
        </label>
        <label className="field">
          <span>
            SOL amount <small className="muted">· balance {fmt(solBalance, 4)} SOL</small>
          </span>
          <input inputMode="decimal" placeholder="0" value={solAmount} onChange={(e) => setSolAmount(e.target.value)} />
        </label>
      </div>

      <label className="field">
        <span>Fee tier</span>
        <select value={configId} onChange={(e) => setConfigId(e.target.value)}>
          {configs.map((c) => (
            <option key={c.id} value={c.id}>
              {(c.tradeFeeRate / 10000).toFixed(c.tradeFeeRate < 100 ? 3 : 2)}% trade fee
              {c.creatorFeeRate > 0 ? ` · ${(c.creatorFeeRate / 10000).toFixed(2)}% creator fee` : ''} · config #{c.index}
            </option>
          ))}
        </select>
      </label>

      <div className="summary">
        <div>
          <span>Initial price</span>
          <strong>{price ? `${fmt(price.toString(), 12)} SOL` : '—'}</strong>
        </div>
        <div>
          <span>Initial FDV</span>
          <strong>{price && supplyHuman ? `${fmt(price.mul(supplyHuman).toString(), 2)} SOL` : '—'}</strong>
        </div>
        <div>
          <span>Raydium pool fee</span>
          <strong>{config ? `${fmt(createFee, 4)} SOL` : '—'}</strong>
        </div>
      </div>

      {info?.freezeAuthority && (
        <Status kind="info">⚠ Freeze authority is still active — traders and scanners will flag this token.</Status>
      )}
      {insufficient && <Status kind="error">Insufficient balance for these amounts (incl. fees).</Status>}
      {error && <Status kind="error">{error}</Status>}
      {done && (
        <Status kind="success">
          Pool created: <code>{short(done.poolId, 6)}</code> <CopyButton text={done.poolId} /> ·{' '}
          <a href={explorerUrl('tx', done.txId, network)} target="_blank" rel="noreferrer">
            Transaction ↗
          </a>
        </Status>
      )}

      <button
        className="btn primary full"
        disabled={busy || !info || !config || !price || !!insufficient}
        onClick={submit}
      >
        {busy ? 'Creating pool…' : 'Create Pool'}
      </button>
    </div>
  )
}

interface PoolView {
  record: PoolRecord
  loading: boolean
  error?: string
  tokenMint?: string
  tokenSymbol?: string
  tokenReserve?: number
  solReserve?: number
  price?: number
  lpSupply?: number
  lpDecimals?: number
  lpBalance?: bigint
}

function PoolCard({ view, network, onRemove, onForget }: {
  view: PoolView
  network: Network
  onRemove: (v: PoolView) => void
  onForget: (id: string) => void
}) {
  const share = view.lpBalance !== undefined && view.lpSupply ? Number(fromRaw(view.lpBalance.toString(), view.lpDecimals!)) / view.lpSupply : 0
  return (
    <div className="card pool-card">
      <div className="pool-head">
        <div>
          <strong>{view.tokenSymbol || short(view.tokenMint || view.record.mintA)} / SOL</strong>
          <code className="muted">
            {short(view.record.poolId, 6)} <CopyButton text={view.record.poolId} />
          </code>
        </div>
        <div className="row">
          <button className="icon-btn" title="Remove liquidity" disabled={!view.lpBalance} onClick={() => onRemove(view)}>
            −
          </button>
          <button className="icon-btn" title="Hide from list" onClick={() => onForget(view.record.poolId)}>
            ×
          </button>
        </div>
      </div>
      {view.loading ? (
        <p className="muted">Loading pool…</p>
      ) : view.error ? (
        <p className="warn-text">{view.error}</p>
      ) : (
        <div className="pool-stats">
          <div>
            <span>Price</span>
            <strong>{fmt(view.price!, 12)} SOL</strong>
          </div>
          <div>
            <span>Pooled SOL</span>
            <strong>{fmt(view.solReserve!, 4)}</strong>
          </div>
          <div>
            <span>Pooled {view.tokenSymbol || 'token'}</span>
            <strong>{fmt(view.tokenReserve!, 2)}</strong>
          </div>
          <div>
            <span>Your share</span>
            <strong>{(share * 100).toFixed(2)}%</strong>
          </div>
        </div>
      )}
      <div className="row wrap">
        <a
          className="btn ghost sm"
          href={
            network === 'mainnet'
              ? `https://raydium.io/swap/?inputMint=sol&outputMint=${view.tokenMint}`
              : explorerUrl('account', view.record.poolId, network)
          }
          target="_blank"
          rel="noreferrer"
        >
          {network === 'mainnet' ? 'Trade on Raydium ↗' : 'View pool ↗'}
        </a>
        {view.tokenMint && (
          <a className="btn ghost sm" href={explorerUrl('token', view.tokenMint, network)} target="_blank" rel="noreferrer">
            Token ↗
          </a>
        )}
      </div>
    </div>
  )
}

function RemoveModal({ view, onClose, onConfirm }: {
  view: PoolView
  onClose: () => void
  onConfirm: (lp: bigint) => Promise<void>
}) {
  const [pct, setPct] = useState(100)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lp = (view.lpBalance! * BigInt(pct)) / 100n
  const share = view.lpSupply ? Number(fromRaw(lp.toString(), view.lpDecimals!)) / view.lpSupply : 0
  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h3>Remove liquidity — {view.tokenSymbol || 'Token'} / SOL</h3>
        <div className="pct-big">{pct}%</div>
        <input type="range" min={1} max={100} value={pct} onChange={(e) => setPct(Number(e.target.value))} />
        <div className="pct">
          {[25, 50, 75, 100].map((p) => (
            <button key={p} onClick={() => setPct(p)}>
              {p}%
            </button>
          ))}
        </div>
        <div className="summary">
          <div>
            <span>You receive (est.)</span>
            <strong>{fmt((view.solReserve || 0) * share, 4)} SOL</strong>
          </div>
          <div>
            <span>+</span>
            <strong>
              {fmt((view.tokenReserve || 0) * share, 2)} {view.tokenSymbol || 'tokens'}
            </strong>
          </div>
        </div>
        {error && <Status kind="error">{error}</Status>}
        <div className="row end">
          <button className="btn ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={busy || lp === 0n}
            onClick={async () => {
              setBusy(true)
              setError('')
              try {
                await onConfirm(lp)
                onClose()
              } catch (e) {
                console.error(e)
                setError(errorMessage(e))
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? 'Removing…' : 'Remove Liquidity'}
          </button>
        </div>
      </div>
    </div>
  )
}

function MyPools({ raydium, refreshKey }: { raydium: Raydium; refreshKey: number }) {
  const { connection } = useConnection()
  const { publicKey } = useWallet()
  const { network } = useSettings()
  const owner = publicKey!.toBase58()
  const [views, setViews] = useState<PoolView[]>([])
  const [manualId, setManualId] = useState('')
  const [scanning, setScanning] = useState(false)
  const [removing, setRemoving] = useState<PoolView | null>(null)
  const [notice, setNotice] = useState('')
  const [tick, setTick] = useState(0)

  const load = useCallback(async () => {
    const records = getPools(owner, network)
    const symbols = new Map(getTokens(owner, network).map((t) => [t.mint, t.symbol]))
    setViews(records.map((record) => ({ record, loading: true })))
    const loaded = await Promise.all(
      records.map(async (record): Promise<PoolView> => {
        try {
          const { poolInfo } = await getPool(raydium, record.poolId)
          const solIsA = poolInfo.mintA.address === WSOL_MINT
          const token = solIsA ? poolInfo.mintB : poolInfo.mintA
          const lpBalance = await getLpBalance(connection, publicKey!, poolInfo.lpMint.address)
          return {
            record,
            loading: false,
            tokenMint: token.address,
            tokenSymbol: symbols.get(token.address) || token.symbol || undefined,
            tokenReserve: solIsA ? poolInfo.mintAmountB : poolInfo.mintAmountA,
            solReserve: solIsA ? poolInfo.mintAmountA : poolInfo.mintAmountB,
            price: solIsA ? 1 / poolInfo.price : poolInfo.price,
            lpSupply: poolInfo.lpAmount,
            lpDecimals: poolInfo.lpMint.decimals,
            lpBalance,
          }
        } catch (e) {
          return { record, loading: false, error: errorMessage(e) }
        }
      }),
    )
    setViews(loaded)
  }, [owner, network, raydium, connection, publicKey])

  useEffect(() => {
    load()
  }, [load, refreshKey, tick])

  const track = (poolId: string, lpMint: string, mintA: string, mintB: string) =>
    addPool({ poolId, lpMint, mintA, mintB, creator: owner, network, createdAt: Date.now() })

  const scan = async () => {
    setScanning(true)
    setNotice('')
    let found = 0
    try {
      for (const t of getTokens(owner, network)) {
        for (const p of await findPoolsForMint(raydium, network, t.mint)) {
          if ('lpMint' in p) track(p.id, p.lpMint.address, p.mintA.address, p.mintB.address)
          found++
        }
      }
      setNotice(found ? `Found ${found} pool(s).` : 'No Raydium CPMM pools found for your created tokens (the API can lag 10–15 min).')
      setTick((x) => x + 1)
    } catch (e) {
      setNotice(errorMessage(e))
    } finally {
      setScanning(false)
    }
  }

  const addManual = async () => {
    setNotice('')
    try {
      const { poolInfo } = await getPool(raydium, manualId.trim())
      track(manualId.trim(), poolInfo.lpMint.address, poolInfo.mintA.address, poolInfo.mintB.address)
      setManualId('')
      setTick((x) => x + 1)
    } catch (e) {
      setNotice(`Not a Raydium CPMM pool on ${network}: ${errorMessage(e)}`)
    }
  }

  return (
    <div className="pools">
      <div className="pools-head">
        <h3>Your Pools</h3>
        <div className="row wrap">
          <button className="btn ghost sm" disabled={scanning} onClick={scan}>
            {scanning ? 'Scanning…' : 'Scan my tokens'}
          </button>
          <button className="btn ghost sm" onClick={() => setTick((x) => x + 1)}>
            ↻ Refresh
          </button>
        </div>
      </div>
      <div className="input-row">
        <input placeholder="Add existing CPMM pool by ID" value={manualId} onChange={(e) => setManualId(e.target.value)} />
        <button className="btn ghost" disabled={!manualId.trim()} onClick={addManual}>
          Add
        </button>
      </div>
      {notice && <p className="hint">{notice}</p>}
      {views.length === 0 ? (
        <div className="card empty">No pools yet. Create one above, or scan / add an existing pool.</div>
      ) : (
        <div className="pool-grid">
          {views.map((v) => (
            <PoolCard
              key={v.record.poolId}
              view={v}
              network={network}
              onRemove={setRemoving}
              onForget={(id) => {
                removePool(id)
                setTick((x) => x + 1)
              }}
            />
          ))}
        </div>
      )}
      {removing && (
        <RemoveModal
          view={removing}
          onClose={() => setRemoving(null)}
          onConfirm={async (lp) => {
            await removeLiquidity(raydium, network, removing.record.poolId, lp)
            setTick((x) => x + 1)
          }}
        />
      )}
    </div>
  )
}

export default function Liquidity() {
  const { publicKey } = useWallet()
  const { raydium, error } = useRaydium()
  const [refreshKey, setRefreshKey] = useState(0)

  return (
    <>
      <section className="hero">
        <h1>
          Manage Raydium Liquidity <span className="accent">💧</span>
        </h1>
        <p>Create Raydium CPMM pools for your tokens. LP tokens stay in your wallet — remove liquidity any time.</p>
      </section>
      {!publicKey ? (
        <ConnectGate text="Connect your wallet to create and manage liquidity pools for your tokens." />
      ) : error ? (
        <Status kind="error">Could not initialise Raydium SDK: {error}</Status>
      ) : !raydium ? (
        <div className="card empty">Loading Raydium…</div>
      ) : (
        <>
          <CreatePoolCard raydium={raydium} onCreated={() => setRefreshKey((k) => k + 1)} />
          <MyPools raydium={raydium} refreshKey={refreshKey} />
        </>
      )}
    </>
  )
}
