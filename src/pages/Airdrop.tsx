import { useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import type { Transaction } from '@solana/web3.js'
import Decimal from 'decimal.js'
import {
  buildAirdropTxs,
  countNewAccounts,
  estimateCost,
  loadMint,
  parseRecipients,
  tokenBalance,
  toRawAmount,
  RECIPIENTS_PER_TX,
  type MintInfo,
  type Recipient,
} from '../lib/airdrop'
import { getReferrer } from '../lib/referral'
import { AIRDROP_FEE_SOL, explorerUrl, useSettings } from '../lib/settings'
import { getTokens } from '../lib/storage'
import { ConnectGate, errorMessage, short, Status } from '../lib/ui'

const MAX_RECIPIENTS = 2000
const TXS_PER_APPROVAL = 10

type Result = { address: string; amount: string; status: 'sent' | 'failed'; signature?: string; error?: string }

const sentKey = (mint: string) => `cf.airdrop.${mint}`
function loadSent(mint: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(sentKey(mint)) || '[]') as string[])
  } catch {
    return new Set()
  }
}
function saveSent(mint: string, sent: Set<string>) {
  try {
    localStorage.setItem(sentKey(mint), JSON.stringify([...sent]))
  } catch {
    /* storage unavailable: resume just won't skip */
  }
}

function downloadCsv(results: Result[]) {
  const rows = ['address,amount,status,signature,error', ...results.map((r) => [r.address, r.amount, r.status, r.signature ?? '', (r.error ?? '').replace(/,/g, ';')].join(','))]
  const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'airdrop-results.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export default function Airdrop() {
  const { connection } = useConnection()
  const wallet = useWallet()
  const { network } = useSettings()
  const owner = wallet.publicKey?.toBase58() ?? ''
  const myTokens = useMemo(() => (owner ? getTokens(owner, network) : []), [owner, network])

  const [mint, setMint] = useState(myTokens[0]?.mint ?? '')
  const [mintInfo, setMintInfo] = useState<MintInfo | null>(null)
  const [balance, setBalance] = useState<bigint>(0n)
  const [solBalance, setSolBalance] = useState(0)
  const [listText, setListText] = useState('')
  const [defaultAmount, setDefaultAmount] = useState('')
  const [skipSent, setSkipSent] = useState(true)
  const [newAccounts, setNewAccounts] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [results, setResults] = useState<Result[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    setMintInfo(null)
    setError('')
    if (!wallet.publicKey || mint.length < 32) return
    let cancelled = false
    loadMint(connection, mint)
      .then(async (m) => {
        const bal = await tokenBalance(connection, wallet.publicKey!, m)
        if (cancelled) return
        setMintInfo(m)
        setBalance(bal)
      })
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [mint, connection, wallet.publicKey])

  useEffect(() => {
    if (wallet.publicKey) connection.getBalance(wallet.publicKey).then((l) => setSolBalance(l / 1e9)).catch(() => {})
  }, [connection, wallet.publicKey, results])

  const parsed = useMemo(() => parseRecipients(listText, defaultAmount, owner ? [owner] : []), [listText, defaultAmount, owner])
  const alreadySent = useMemo(() => (mint ? loadSent(mint) : new Set<string>()), [mint, results])
  const recipients = useMemo(
    () => (skipSent ? parsed.valid.filter((r) => !alreadySent.has(r.address)) : parsed.valid),
    [parsed, skipSent, alreadySent],
  )
  const skipped = parsed.valid.length - recipients.length

  // Rent depends on how many recipients still need a token account — checked on-chain (debounced)
  useEffect(() => {
    setNewAccounts(null)
    if (!mintInfo || !recipients.length || recipients.length > MAX_RECIPIENTS) return
    const t = setTimeout(() => {
      countNewAccounts(connection, mintInfo, recipients).then(setNewAccounts).catch(() => setNewAccounts(recipients.length))
    }, 600)
    return () => clearTimeout(t)
  }, [mintInfo, recipients, connection])

  const totalRaw = useMemo(
    () => (mintInfo ? recipients.reduce((s, r) => s + toRawAmount(r.amount, mintInfo.decimals), 0n) : 0n),
    [recipients, mintInfo],
  )
  const human = (raw: bigint) => (mintInfo ? new Decimal(raw.toString()).div(new Decimal(10).pow(mintInfo.decimals)).toNumber().toLocaleString('en-US') : '—')
  const cost = estimateCost(recipients.length, newAccounts ?? recipients.length, network, wallet.publicKey)
  const solNeeded = cost.rentSol + cost.networkSol + cost.platformSol
  const tooMany = recipients.length > MAX_RECIPIENTS
  const notEnoughTokens = !!mintInfo && totalRaw > balance
  const notEnoughSol = solNeeded > solBalance

  const loadFile = async (file?: File) => {
    if (file) setListText(await file.text())
  }

  const send = async () => {
    if (!wallet.publicKey || !mintInfo) return
    setBusy(true)
    setError('')
    setResults([])
    const batches = buildAirdropTxs(wallet.publicKey, mintInfo, recipients, network, getReferrer(wallet.publicKey))
    setProgress({ done: 0, total: recipients.length })
    const sent = loadSent(mint)
    const out: Result[] = []
    try {
      for (let i = 0; i < batches.length; i += TXS_PER_APPROVAL) {
        const chunk = batches.slice(i, i + TXS_PER_APPROVAL)
        const latest = await connection.getLatestBlockhash('confirmed')
        for (const b of chunk) {
          b.tx.recentBlockhash = latest.blockhash
          b.tx.feePayer = wallet.publicKey
        }
        // One wallet approval per chunk where supported
        const signed: Transaction[] = wallet.signAllTransactions
          ? await wallet.signAllTransactions(chunk.map((b) => b.tx))
          : await Promise.all(chunk.map((b) => wallet.signTransaction!(b.tx)))
        for (const [j, tx] of signed.entries()) {
          const batch = chunk[j].recipients
          try {
            const sig = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 })
            const conf = await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed')
            if (conf.value.err) throw new Error(JSON.stringify(conf.value.err))
            batch.forEach((r) => {
              out.push({ ...r, status: 'sent', signature: sig })
              sent.add(r.address)
            })
            saveSent(mint, sent)
          } catch (e) {
            batch.forEach((r: Recipient) => out.push({ ...r, status: 'failed', error: errorMessage(e) }))
          }
          setResults([...out])
          setProgress({ done: out.length, total: recipients.length })
        }
      }
    } catch (e) {
      // Wallet rejection stops the run; everything sent so far is remembered for resuming
      setError(errorMessage(e))
    } finally {
      setResults([...out])
      setBusy(false)
      tokenBalance(connection, wallet.publicKey, mintInfo).then(setBalance).catch(() => {})
    }
  }

  const failed = results.filter((r) => r.status === 'failed')
  const sentCount = results.length - failed.length

  return (
    <>
      <section className="hero">
        <h1>
          Airdrop <span className="accent">🪂</span>
        </h1>
        <p>Send your token to a list of wallets — giveaway winners, your community, early supporters. Signed in your wallet.</p>
      </section>

      {!wallet.publicKey ? (
        <ConnectGate text="Connect your wallet to airdrop your tokens." />
      ) : (
        <>
          <Status kind="info">
            Only airdrop to people who asked for it (giveaways, sign-up forms, your holders). Unsolicited tokens are hidden as
            spam by Phantom & co., and recipients who didn't want them usually sell immediately.
          </Status>

          <div className="card">
            <h3>1 · Token</h3>
            <div className="input-row">
              <input placeholder="Token mint address" value={mint} onChange={(e) => setMint(e.target.value.trim())} />
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
            {mintInfo && (
              <p className="hint">
                Your balance: <strong>{human(balance)}</strong> · decimals {mintInfo.decimals} ·{' '}
                {mintInfo.programId.toBase58().startsWith('Tokenz') ? 'Token-2022' : 'SPL Token'}
              </p>
            )}
          </div>

          <div className="card">
            <h3>2 · Recipients</h3>
            <label className="field">
              <span>
                One wallet per line — optionally with an amount: <code>address,amount</code>
                <label className="btn ghost sm file-btn">
                  Import CSV
                  <input type="file" accept=".csv,.txt" hidden onChange={(e) => loadFile(e.target.files?.[0])} />
                </label>
              </span>
              <textarea
                rows={8}
                className="mono"
                placeholder={'7Jcr…3qzc,1000\nAbc1…xyz9\n…'}
                value={listText}
                onChange={(e) => setListText(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Amount for lines without an amount</span>
              <input inputMode="decimal" placeholder="e.g. 1000" value={defaultAmount} onChange={(e) => setDefaultAmount(e.target.value)} />
            </label>
            <div className="token-meta">
              <span className="ok-text">✓ {parsed.valid.length} valid</span>
              {parsed.duplicates > 0 && <span>{parsed.duplicates} duplicates removed</span>}
              {parsed.invalid.length > 0 && <span className="warn-text">{parsed.invalid.length} invalid</span>}
              {alreadySent.size > 0 && (
                <label className="inline-check">
                  <input type="checkbox" checked={skipSent} onChange={(e) => setSkipSent(e.target.checked)} /> skip {skipped} already
                  sent
                </label>
              )}
            </div>
            {parsed.invalid.length > 0 && (
              <details className="invalid-list">
                <summary>Show invalid lines</summary>
                {parsed.invalid.slice(0, 50).map((x) => (
                  <div key={x.line}>
                    Line {x.line}: <code>{x.text.slice(0, 60)}</code> — {x.reason}
                  </div>
                ))}
              </details>
            )}
          </div>

          <div className="card">
            <h3>3 · Review & send</h3>
            <div className="summary">
              <div>
                <span>Recipients</span>
                <strong>{recipients.length}</strong>
              </div>
              <div>
                <span>Tokens needed</span>
                <strong className={notEnoughTokens ? 'warn-text' : ''}>{human(totalRaw)}</strong>
              </div>
              <div>
                <span>Transactions</span>
                <strong>
                  {cost.txs} <small>({Math.ceil(cost.txs / TXS_PER_APPROVAL)} wallet approvals)</small>
                </strong>
              </div>
              <div>
                <span>New token accounts (rent)</span>
                <strong>
                  {newAccounts ?? '…'} · {cost.rentSol.toFixed(3)} SOL
                </strong>
              </div>
              <div>
                <span>Network fees</span>
                <strong>{cost.networkSol.toFixed(4)} SOL</strong>
              </div>
              <div>
                <span>Platform fee</span>
                <strong>{cost.platformSol ? `${cost.platformSol} SOL` : 'Free'}</strong>
                {AIRDROP_FEE_SOL > 0 && !!cost.platformSol && <small className="muted">{AIRDROP_FEE_SOL} SOL per 100 wallets</small>}
              </div>
              <div>
                <span>Total SOL needed</span>
                <strong className={notEnoughSol ? 'warn-text' : 'ok-text'}>
                  ≈ {solNeeded.toFixed(3)} SOL <small>(you have {solBalance.toFixed(3)})</small>
                </strong>
              </div>
            </div>
            <p className="hint">
              Rent is paid by you for every recipient that doesn't hold this token yet (~0.002 SOL each) — it goes into their
              token account, not to CoinForge. Up to {RECIPIENTS_PER_TX} wallets per transaction.
            </p>
            {tooMany && <Status kind="error">Max {MAX_RECIPIENTS} recipients per run — split your list.</Status>}
            {notEnoughTokens && <Status kind="error">Not enough tokens for this list.</Status>}
            {notEnoughSol && recipients.length > 0 && <Status kind="error">Not enough SOL for rent and fees.</Status>}
            {error && <Status kind="error">{error}</Status>}
            {busy && (
              <div className="progress">
                <div style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                <span>
                  {progress.done} / {progress.total} — approve each batch in your wallet
                </span>
              </div>
            )}
            <button
              className="btn primary full"
              disabled={busy || !mintInfo || !recipients.length || tooMany || notEnoughTokens || notEnoughSol || newAccounts === null}
              onClick={send}
            >
              {busy ? 'Sending…' : `🪂 Send to ${recipients.length} wallets`}
            </button>
          </div>

          {results.length > 0 && (
            <div className="card">
              <h3>Results</h3>
              <div className="token-meta">
                <span className="ok-text">✓ {sentCount} sent</span>
                {failed.length > 0 && <span className="warn-text">✗ {failed.length} failed — run again to retry (sent wallets are skipped)</span>}
              </div>
              <div className="row wrap">
                <button className="btn ghost sm" onClick={() => downloadCsv(results)}>
                  ⬇ Download results CSV
                </button>
                {results.find((r) => r.signature) && (
                  <a className="btn ghost sm" href={explorerUrl('tx', results.find((r) => r.signature)!.signature!, network)} target="_blank" rel="noreferrer">
                    First transaction ↗
                  </a>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
