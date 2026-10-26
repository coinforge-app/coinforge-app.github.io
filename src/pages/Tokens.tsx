import { useCallback, useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { fetchCoinInfo, type CoinInfo } from '../lib/market'
import { fromRaw, getMintInfo } from '../lib/raydium'
import { explorerUrl, useSettings } from '../lib/settings'
import { addToken, getPools, getTokens, type TokenRecord } from '../lib/storage'
import { ConnectGate, CopyButton, errorMessage, short, Status } from '../lib/ui'

type MintInfo = Awaited<ReturnType<typeof getMintInfo>>

interface DasAsset {
  id: string
  interface: string
  content?: { json_uri?: string; metadata?: { name?: string; symbol?: string }; links?: { image?: string } }
  token_info?: { decimals?: number; supply?: number }
}

/** Discover tokens whose update authority is the wallet via the DAS API (Helius & co.). */
async function scanDas(rpc: string, authority: string): Promise<DasAsset[]> {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'cf',
      method: 'getAssetsByAuthority',
      params: { authorityAddress: authority, page: 1, limit: 1000 },
    }),
  })
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || 'DAS request failed')
  return (json.result?.items as DasAsset[]).filter((a) => a.interface === 'FungibleToken' || a.interface === 'FungibleAsset')
}

/** ok: null = could not be checked (e.g. RPC without DAS) — shown neutral and left out of the score */
type Check = { ok: boolean | null; label: string; fix?: { text: string; href?: string } }

/** What rug checkers and trading bots look at first, with a way to fix each gap. */
function TrustChecklist({ token, info }: { token: TokenRecord; info: MintInfo | null }) {
  const { connection } = useConnection()
  const { rpc } = useSettings()
  const [coin, setCoin] = useState<CoinInfo | null>(null)
  const [socials, setSocials] = useState<boolean | null>(null)
  const [creatorPct, setCreatorPct] = useState<number | null>(null)

  useEffect(() => {
    fetchCoinInfo(rpc, [token.mint])
      .then((r) => setCoin(r[token.mint]))
      .catch(() => {})
    if (token.uri)
      fetch(token.uri)
        .then((r) => r.json())
        .then((j) => setSocials(!!(j.website || j.twitter || j.telegram || j.extensions?.website || j.extensions?.twitter)))
        .catch(() => setSocials(false))
  }, [rpc, token.mint, token.uri])

  useEffect(() => {
    if (!info) return
    connection
      .getParsedTokenAccountsByOwner(new PublicKey(token.creator), { mint: new PublicKey(token.mint) })
      .then((res) => {
        const held = res.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount as string), 0n)
        setCreatorPct(BigInt(info.supply) > 0n ? Number((held * 10000n) / BigInt(info.supply)) / 100 : 0)
      })
      .catch(() => {})
  }, [connection, info, token.creator, token.mint])

  if (!info) return null
  const checks: Check[] = [
    { ok: !info.mintAuthority, label: 'Mint authority revoked — fixed supply', fix: { text: 'Launch with “Revoke Mint” enabled' } },
    { ok: !info.freezeAuthority, label: 'Freeze authority revoked — no honeypot', fix: { text: 'Launch with “Revoke Freeze” enabled' } },
    { ok: coin?.mutable === undefined ? null : !coin.mutable, label: 'Metadata locked (immutable)', fix: { text: 'Launch with “Revoke Update” enabled' } },
    { ok: socials, label: 'Website / socials in metadata', fix: { text: 'Add website, X and Telegram when launching' } },
    {
      ok: coin ? (coin.liquidityUsd ?? 0) > 0 : null,
      label: 'Tradeable liquidity pool',
      fix: { text: 'Create a pool', href: `#/liquidity?mint=${token.mint}` },
    },
    {
      ok: creatorPct === null ? null : creatorPct <= 10,
      label: `Creator holds ≤ 10% of supply${creatorPct !== null ? ` (now ${creatorPct.toFixed(1)}%)` : ''}`,
      fix: { text: 'Put more supply into the pool or airdrop to your community', href: '#/airdrop' },
    },
  ]
  const known = checks.filter((c) => c.ok !== null)
  const passed = known.filter((c) => c.ok).length
  return (
    <div className="trust">
      <div className="trust-head">
        <span className={`trust-score ${passed === known.length ? 'ok' : passed >= known.length - 2 ? 'mid' : 'bad'}`}>
          Trust score {passed}/{known.length}
        </span>
        <a className="btn ghost sm" href={`https://rugcheck.xyz/tokens/${token.mint}`} target="_blank" rel="noreferrer">
          RugCheck report ↗
        </a>
      </div>
      <ul className="trust-list">
        {checks.map((c) => (
          <li key={c.label} className={c.ok === null ? 'info' : c.ok ? 'ok' : 'bad'}>
            <span>{c.ok === null ? '?' : c.ok ? '✓' : '✗'}</span> {c.label}
            {c.ok === false && c.fix && (c.fix.href ? <a href={c.fix.href}> → {c.fix.text}</a> : <small> → {c.fix.text}</small>)}
          </li>
        ))}
        <li className="info">
          <span>🔒</span> Liquidity locked — check & lock it in <a href={`#/liquidity?mint=${token.mint}`}>Liquidity</a> (shown on each pool)
        </li>
      </ul>
    </div>
  )
}

function TokenDetails({ token }: { token: TokenRecord }) {
  const { connection } = useConnection()
  const { network } = useSettings()
  const [info, setInfo] = useState<MintInfo | null>(null)
  const [error, setError] = useState('')
  const pools = getPools(token.creator, network).filter((p) => p.mintA === token.mint || p.mintB === token.mint)

  useEffect(() => {
    getMintInfo(connection, token.mint)
      .then(setInfo)
      .catch((e) => setError(errorMessage(e)))
  }, [connection, token.mint])

  return (
    <div className="token-details">
      {error && <p className="warn-text">{error}</p>}
      <div className="pool-stats">
        <div>
          <span>Supply</span>
          <strong>{info ? Number(fromRaw(info.supply, info.decimals)).toLocaleString('en-US') : '…'}</strong>
        </div>
        <div>
          <span>Decimals</span>
          <strong>{info?.decimals ?? token.decimals}</strong>
        </div>
        <div>
          <span>Mint authority</span>
          <strong className={info?.mintAuthority ? 'warn-text' : 'ok-text'}>{info ? (info.mintAuthority ? 'Active' : 'Revoked') : '…'}</strong>
        </div>
        <div>
          <span>Freeze authority</span>
          <strong className={info?.freezeAuthority ? 'warn-text' : 'ok-text'}>{info ? (info.freezeAuthority ? 'Active' : 'Revoked') : '…'}</strong>
        </div>
        <div>
          <span>Liquidity</span>
          <strong className={pools.length ? 'ok-text' : 'muted'}>{pools.length ? `${pools.length} pool(s)` : 'No pool'}</strong>
        </div>
      </div>
      <TrustChecklist token={token} info={info} />
      <div className="row wrap">
        <a className="btn ghost sm" href={explorerUrl('token', token.mint, network)} target="_blank" rel="noreferrer">
          Solscan ↗
        </a>
        {token.uri && (
          <a className="btn ghost sm" href={token.uri} target="_blank" rel="noreferrer">
            Metadata JSON ↗
          </a>
        )}
        <a className="btn primary sm" href={`#/liquidity?mint=${token.mint}`}>
          {pools.length ? 'Manage liquidity' : 'Create pool 💧'}
        </a>
        <a className="btn ghost sm" href={`#/promoted?promote=${token.mint}`}>
          🔥 Promote
        </a>
      </div>
    </div>
  )
}

export default function Tokens() {
  const { publicKey } = useWallet()
  const { network, rpc } = useSettings()
  const [tokens, setTokens] = useState<TokenRecord[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const owner = publicKey?.toBase58()

  const reload = useCallback(() => setTokens(owner ? getTokens(owner, network) : []), [owner, network])
  useEffect(reload, [reload])

  const scan = async () => {
    if (!owner) return
    setScanning(true)
    setNotice(null)
    try {
      const assets = await scanDas(rpc, owner)
      const known = new Set(tokens.map((t) => t.mint))
      let added = 0
      for (const a of assets) {
        if (known.has(a.id)) continue
        addToken({
          mint: a.id,
          name: a.content?.metadata?.name || 'Unknown',
          symbol: a.content?.metadata?.symbol || '',
          image: a.content?.links?.image || '',
          uri: a.content?.json_uri || '',
          decimals: a.token_info?.decimals ?? 0,
          supply: String(a.token_info?.supply ?? ''),
          creator: owner,
          network,
          signature: '',
          createdAt: 0,
        })
        added++
      }
      setNotice({ kind: 'info', text: `On-chain scan found ${assets.length} token(s), ${added} new.` })
      reload()
    } catch (e) {
      setNotice({
        kind: 'error',
        text: `On-chain scan needs a DAS-capable RPC (e.g. Helius) — set one in Settings ⚙. (${errorMessage(e)})`,
      })
    } finally {
      setScanning(false)
    }
  }

  // Group by creation day, newest first; discovered tokens without a date go last
  const groups = new Map<string, TokenRecord[]>()
  for (const t of tokens) {
    const label = t.createdAt
      ? new Date(t.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : 'Discovered on-chain'
    groups.set(label, [...(groups.get(label) || []), t])
  }

  return (
    <>
      <section className="hero">
        <h1>
          Your Minted Tokens <span className="accent">💰</span>
        </h1>
        <p>Every token you created, by creation date. Click a token to see on-chain details and liquidity status.</p>
      </section>
      {!publicKey ? (
        <ConnectGate text="Connect your wallet to see the tokens you created." />
      ) : (
        <>
          <div className="pools-head">
            <span className="muted">
              {tokens.length} token(s) on {network}
            </span>
            <button className="btn ghost sm" disabled={scanning} onClick={scan}>
              {scanning ? 'Scanning…' : 'Scan on-chain (DAS)'}
            </button>
          </div>
          {notice && <Status kind={notice.kind}>{notice.text}</Status>}
          {tokens.length === 0 ? (
            <div className="card empty">
              No tokens yet on {network}. <a href="#/create">Create your first token →</a>
            </div>
          ) : (
            [...groups.entries()].map(([label, items]) => (
              <div key={label} className="timeline-group">
                <h4 className="timeline-label">{label}</h4>
                {items.map((t) => (
                  <div key={t.mint} className={open === t.mint ? 'card token-row open' : 'card token-row'}>
                    <button className="token-row-head" onClick={() => setOpen(open === t.mint ? null : t.mint)}>
                      {t.image ? <img className="token-img" src={t.image} alt="" /> : <div className="token-img ph">?</div>}
                      <div className="token-name">
                        <strong>{t.name}</strong>
                        <span className="muted">${t.symbol}</span>
                      </div>
                      <code className="muted hide-sm">{short(t.mint, 6)}</code>
                      <span className="muted">{t.createdAt ? new Date(t.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                      <span className="chev">{open === t.mint ? '▴' : '▾'}</span>
                    </button>
                    {open === t.mint && (
                      <>
                        <div className="kv">
                          <span>Mint</span>
                          <code>
                            {t.mint} <CopyButton text={t.mint} />
                          </code>
                        </div>
                        <TokenDetails token={t} />
                      </>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </>
      )}
    </>
  )
}
