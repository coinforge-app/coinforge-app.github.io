import { useCallback, useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
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
