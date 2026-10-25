import { PublicKey, type Connection } from '@solana/web3.js'
import { fetchParsed, MEMO_RE } from './promote'
import { FEE_WALLET, LAUNCH_HOURS, PROMO_BLOCKLIST } from './settings'

// "Just launched": every token created through CoinForge pays its fee to FEE_WALLET, so the fee wallet's
// recent history doubles as a free, serverless feed of new launches.

const TOKEN_METADATA = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
const MAX_LAUNCHES = 50

export interface Launch {
  mint: string
  creator: string
  /** Unix seconds */
  createdAt: number
  signature: string
}

export async function fetchLaunches(connection: Connection): Promise<Launch[]> {
  if (!FEE_WALLET) return []
  const since = Math.floor(Date.now() / 1000) - LAUNCH_HOURS * 3600
  const sigs = (await connection.getSignaturesForAddress(new PublicKey(FEE_WALLET), { limit: 1000 }))
    .filter((s) => !s.err && (s.blockTime ?? 0) >= since && !(s.memo && MEMO_RE.test(s.memo)))
    .slice(0, MAX_LAUNCHES)
  if (!sigs.length) return []
  const parsed = await fetchParsed(connection, sigs.map((s) => s.signature))

  const seen = new Set<string>()
  const launches: Launch[] = []
  sigs.forEach((sig, i) => {
    const tx = parsed[i]
    if (!tx?.meta || tx.meta.err) return
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58())
    if (!keys.includes(TOKEN_METADATA)) return // not a token creation
    const creator = keys[0]
    // The freshly minted supply lands in the creator's token account
    const mint = tx.meta.postTokenBalances?.find((b) => b.owner === creator)?.mint
    if (!mint || seen.has(mint) || PROMO_BLOCKLIST.has(mint)) return
    seen.add(mint)
    launches.push({ mint, creator, createdAt: sig.blockTime ?? tx.blockTime ?? 0, signature: sig.signature })
  })
  return launches
}

export function ago(unix: number) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}
