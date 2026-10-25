import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { fetchEarnings, type EarningTx } from '../lib/earnings'
import { isOwner } from '../lib/promote'
import { explorerUrl, REF_PERCENT, useSettings } from '../lib/settings'
import { ConnectGate, CopyButton, errorMessage, short, Status } from '../lib/ui'

const sol = (lamports: number, digits = 3) => `${(lamports / 1e9).toFixed(digits)} SOL`
const KIND_LABEL = { token: '🪙 Token', promotion: '🔥 Promotion', other: '↘ Other' } as const

export default function Earnings() {
  const { publicKey } = useWallet()
  const { connection } = useConnection()
  const { network } = useSettings()
  const [txs, setTxs] = useState<EarningTx[] | null>(null)
  const [error, setError] = useState('')
  const owner = isOwner(publicKey)

  const load = useCallback(() => {
    setError('')
    setTxs(null)
    fetchEarnings(connection)
      .then(setTxs)
      .catch((e) => {
        setError(errorMessage(e))
        setTxs([])
      })
  }, [connection])

  useEffect(() => {
    if (owner) load()
  }, [owner, load])

  const stats = useMemo(() => {
    const now = Date.now() / 1000
    const list = txs ?? []
    const sum = (f: (t: EarningTx) => boolean) => list.filter(f).reduce((s, t) => s + t.toYou, 0)
    const refs = new Map<string, { count: number; paid: number; yours: number }>()
    for (const t of list) {
      if (!t.referrer) continue
      const r = refs.get(t.referrer) ?? { count: 0, paid: 0, yours: 0 }
      refs.set(t.referrer, { count: r.count + 1, paid: r.paid + t.toReferrer, yours: r.yours + t.toYou })
    }
    return {
      total: sum(() => true),
      day: sum((t) => now - t.time < 86400),
      week: sum((t) => now - t.time < 7 * 86400),
      tokens: list.filter((t) => t.kind === 'token').length,
      promos: list.filter((t) => t.kind === 'promotion').length,
      refPaid: list.reduce((s, t) => s + t.toReferrer, 0),
      topRefs: [...refs.entries()].sort((a, b) => b[1].yours - a[1].yours).slice(0, 10),
    }
  }, [txs])

  if (!publicKey) return <ConnectGate text="Connect the platform owner wallet to see earnings." />
  if (!owner) return <Status kind="info">This page is only available to the platform owner.</Status>

  return (
    <>
      <section className="hero">
        <h1>
          Earnings <span className="accent">📊</span>
        </h1>
        <p>Income to your fee wallet on {network}, read directly from the chain. Only visible to you.</p>
        <div className="row center hero-actions">
          <button className="btn ghost sm" onClick={load} disabled={txs === null}>
            ↻ Refresh
          </button>
        </div>
      </section>

      {error && <Status kind="error">{error}</Status>}

      <div className="stat-grid">
        {[
          ['Total received', sol(stats.total)],
          ['Last 24h', sol(stats.day)],
          ['Last 7 days', sol(stats.week)],
          ['Tokens launched', String(stats.tokens)],
          ['Promotions sold', String(stats.promos)],
          [`Paid to referrers (${REF_PERCENT}%)`, sol(stats.refPaid)],
        ].map(([label, value]) => (
          <div key={label} className="card stat">
            <span>{label}</span>
            <strong>{txs === null ? '…' : value}</strong>
          </div>
        ))}
      </div>

      {stats.topRefs.length > 0 && (
        <div className="card">
          <h3>Top referrers</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Referrer</th>
                  <th>Sales</th>
                  <th>Paid to them</th>
                  <th>Your revenue</th>
                </tr>
              </thead>
              <tbody>
                {stats.topRefs.map(([wallet, r]) => (
                  <tr key={wallet}>
                    <td>
                      <code>{short(wallet, 5)}</code> <CopyButton text={wallet} />
                    </td>
                    <td>{r.count}</td>
                    <td>{sol(r.paid)}</td>
                    <td className="ok-text">{sol(r.yours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <h3>Recent income</h3>
        {txs === null ? (
          <p className="muted">Scanning fee wallet history…</p>
        ) : txs.length === 0 ? (
          <p className="muted">No income yet on {network}.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Customer</th>
                  <th>You</th>
                  <th>Referrer</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {txs.slice(0, 100).map((t) => (
                  <tr key={t.signature}>
                    <td>{new Date(t.time * 1000).toLocaleString()}</td>
                    <td>{KIND_LABEL[t.kind]}</td>
                    <td>
                      <code>{short(t.payer, 4)}</code>
                    </td>
                    <td className="ok-text">+{sol(t.toYou, 4)}</td>
                    <td>{t.referrer ? `${sol(t.toReferrer, 4)} → ${short(t.referrer, 4)}` : '—'}</td>
                    <td>
                      <a href={explorerUrl('tx', t.signature, network)} target="_blank" rel="noreferrer">
                        ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">“Other” = SOL sent to your wallet outside CoinForge (e.g. deposits). Scans the latest 2,000 transactions.</p>
      </div>
    </>
  )
}
