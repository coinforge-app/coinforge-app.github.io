import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
  type ConfirmedSignatureInfo,
  type ParsedTransactionWithMeta,
} from '@solana/web3.js'
import { splitFee } from './referral'
import {
  FEE_WALLET,
  PROMO_BLOCKLIST,
  PROMO_BOOST_SOL,
  PROMO_HOURS,
  PROMO_SOL,
  PROMO_TOP_SOL,
  REF_PERCENT,
  type Network,
} from './settings'

// Promotions live entirely on-chain: a payment to FEE_WALLET carrying a memo
// "coinforge:promote:<mint>:<tier>". The homepage reads the fee wallet's history, so no backend is needed.

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const MEMO_PREFIX = 'coinforge:promote:'
export const MEMO_RE = /coinforge:promote:([1-9A-HJ-NP-Za-km-z]{32,44})(?::(basic|boost|top))?/

export type TierId = 'basic' | 'boost' | 'top'
export const TIERS: Record<TierId, { label: string; badge: string; sol: number; points: number; rank: number; perk: string }> = {
  basic: { label: 'Basic', badge: '🔥 Promoted', sol: PROMO_SOL, points: 1, rank: 1, perk: 'Listed on the homepage' },
  boost: { label: 'Boost', badge: '⚡ Boosted', sol: PROMO_BOOST_SOL, points: 3, rank: 2, perk: 'Ranked above all basic coins' },
  top: { label: 'Top Spot', badge: '👑 Top Spot', sol: PROMO_TOP_SOL, points: 10, rank: 3, perk: 'Pinned to #1 with a gold frame' },
}
const TIER_ORDER: TierId[] = ['basic', 'boost', 'top']
const lamportsOf = (tier: TierId) => Math.round(TIERS[tier].sol * LAMPORTS_PER_SOL)
/** Minimum the fee wallet must receive for a tier (the referral share may go elsewhere) */
const minReceived = (tier: TierId) => Math.floor((lamportsOf(tier) * (100 - REF_PERCENT)) / 100)
const LOOKBACK_SECONDS = 7 * 24 * 3600
const MAX_PAGES = 5

export interface Promotion {
  mint: string
  /** Latest payment signature */
  signature: string
  /** Unix seconds of the latest payment */
  paidAt: number
  /** Unix seconds when the (stacked) promotion ends */
  expiresAt: number
  /** Number of payments that count towards the current run */
  boosts: number
  /** Promoted by the platform owner (fee wallet) */
  featured: boolean
  /** Highest tier among payments still inside their own window */
  tier: TierId
  /** Sum of tier points of active payments (ranking within a tier) */
  points: number
}

export function promotionsEnabled() {
  return !!FEE_WALLET
}

export function isOwner(wallet: PublicKey | null) {
  return !!wallet && !!FEE_WALLET && wallet.toBase58() === FEE_WALLET
}

export async function checkMint(connection: Connection, mint: string) {
  let key: PublicKey
  try {
    key = new PublicKey(mint)
  } catch {
    throw new Error('Not a valid address')
  }
  const info = await connection.getParsedAccountInfo(key)
  const data = info.value?.data
  if (!info.value || !data || !('parsed' in data) || data.parsed.type !== 'mint') throw new Error('Not a token mint on this network')
  return key
}

/** Memo + payment to the fee wallet (split with a referrer). The owner only writes the memo (free). */
export function buildPromoteTx(
  payer: PublicKey,
  mint: string,
  network: Network,
  referrer: PublicKey | null = null,
  tier: TierId = 'basic',
) {
  const tx = new Transaction()
  if (network === 'mainnet') {
    // Memo program alone uses ~37k CU; keep headroom
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }))
  }
  if (!isOwner(payer)) {
    for (const p of splitFee(lamportsOf(tier), referrer)) {
      tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: p.to, lamports: p.lamports }))
    }
  }
  tx.add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM,
      keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
      data: Buffer.from(`${MEMO_PREFIX}${mint}:${tier}`, 'utf8'),
    }),
  )
  return tx
}

async function recentMemoSignatures(connection: Connection, feeWallet: PublicKey, now: number) {
  const found: ConfirmedSignatureInfo[] = []
  let before: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await connection.getSignaturesForAddress(feeWallet, { limit: 1000, before })
    found.push(...batch.filter((s) => !s.err && s.memo && MEMO_RE.test(s.memo)))
    const oldest = batch[batch.length - 1]
    if (batch.length < 1000 || !oldest?.blockTime || oldest.blockTime < now - LOOKBACK_SECONDS) break
    before = oldest.signature
  }
  return found
}

export async function fetchParsed(connection: Connection, signatures: string[]) {
  const out: (ParsedTransactionWithMeta | null)[] = []
  for (let i = 0; i < signatures.length; i += 50) {
    const chunk = signatures.slice(i, i + 50)
    try {
      out.push(...(await connection.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 0 })))
    } catch {
      // Some RPCs reject JSON-RPC batches — fall back to one request per transaction
      for (const sig of chunk) out.push(await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 }))
    }
  }
  return out
}

/**
 * The tier a payment actually bought, or null if it doesn't count. The fee wallet must have received
 * at least the tier price minus the referral share; the owner (signing itself) gets the memo's tier for free.
 */
function paidTier(tx: ParsedTransactionWithMeta | null, feeWallet: string, memoTier: TierId | undefined): TierId | null {
  if (!tx?.meta || tx.meta.err) return null
  const keys = tx.transaction.message.accountKeys
  const idx = keys.findIndex((k) => k.pubkey.toBase58() === feeWallet)
  if (idx < 0) return null
  if (idx === 0 && keys[0].signer) return memoTier ?? 'basic'
  const received = tx.meta.postBalances[idx] - tx.meta.preBalances[idx]
  const affordable = TIER_ORDER.filter((t) => received >= minReceived(t)).pop()
  if (!affordable) return null
  // Never grant more than the memo asked for (older memos without a tier count by amount)
  return memoTier && TIERS[memoTier].rank < TIERS[affordable].rank ? memoTier : affordable
}

export async function fetchPromotions(connection: Connection): Promise<Promotion[]> {
  if (!FEE_WALLET) return []
  const now = Math.floor(Date.now() / 1000)
  const sigs = await recentMemoSignatures(connection, new PublicKey(FEE_WALLET), now)
  if (!sigs.length) return []
  const parsed = await fetchParsed(connection, sigs.map((s) => s.signature))

  const window = PROMO_HOURS * 3600
  const payments = sigs
    .map((s, i) => {
      const [, mint, memoTier] = MEMO_RE.exec(s.memo!)!
      const tx = parsed[i]
      return { sig: s, tx, mint, tier: paidTier(tx, FEE_WALLET, memoTier as TierId | undefined) }
    })
    .filter((p) => p.tier !== null)
    .map(({ sig, tx, mint, tier }) => ({
      mint,
      tier: tier!,
      signature: sig.signature,
      paidAt: sig.blockTime ?? tx!.blockTime ?? now,
      featured: tx!.transaction.message.accountKeys[0].pubkey.toBase58() === FEE_WALLET,
    }))
    .sort((a, b) => a.paidAt - b.paidAt)

  // Each payment lists the coin for PROMO_HOURS (payments during a run extend it).
  // Tier and points only count while that payment's own window is still open.
  const byMint = new Map<string, Promotion>()
  for (const p of payments) {
    const prev = byMint.get(p.mint)
    const running = prev && prev.expiresAt > p.paidAt
    const active = p.paidAt + window > now
    const base = running ? prev : undefined
    const tier = active && (!base || TIERS[p.tier].rank > TIERS[base.tier].rank) ? p.tier : (base?.tier ?? 'basic')
    byMint.set(p.mint, {
      mint: p.mint,
      signature: p.signature,
      paidAt: p.paidAt,
      expiresAt: (running ? prev.expiresAt : p.paidAt) + window,
      boosts: running ? prev.boosts + 1 : 1,
      featured: p.featured || (running ? prev.featured : false),
      tier,
      points: (base?.points ?? 0) + (active ? TIERS[p.tier].points : 0),
    })
  }

  return [...byMint.values()]
    .filter((p) => p.expiresAt > now && !PROMO_BLOCKLIST.has(p.mint))
    .sort((a, b) => TIERS[b.tier].rank - TIERS[a.tier].rank || b.points - a.points || b.paidAt - a.paidAt)
}

export function timeLeft(expiresAt: number) {
  const s = Math.max(0, expiresAt - Math.floor(Date.now() / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`
}
