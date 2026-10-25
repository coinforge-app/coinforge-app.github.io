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
import { FEE_WALLET, PROMO_BLOCKLIST, PROMO_HOURS, PROMO_SOL, type Network } from './settings'

// Promotions live entirely on-chain: a payment to FEE_WALLET carrying a memo
// "coinforge:promote:<mint>". The homepage reads the fee wallet's history, so no backend is needed.

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const MEMO_PREFIX = 'coinforge:promote:'
const MEMO_RE = /coinforge:promote:([1-9A-HJ-NP-Za-km-z]{32,44})/
const PRICE_LAMPORTS = Math.round(PROMO_SOL * LAMPORTS_PER_SOL)
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

/** Memo + payment to the fee wallet. The owner only writes the memo (free). */
export function buildPromoteTx(payer: PublicKey, mint: string, network: Network) {
  const tx = new Transaction()
  if (network === 'mainnet') {
    // Memo program alone uses ~37k CU; keep headroom
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }))
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }))
  }
  if (!isOwner(payer)) {
    tx.add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(FEE_WALLET), lamports: PRICE_LAMPORTS }))
  }
  tx.add(
    new TransactionInstruction({
      programId: MEMO_PROGRAM,
      keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
      data: Buffer.from(MEMO_PREFIX + mint, 'utf8'),
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

async function fetchParsed(connection: Connection, signatures: string[]) {
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

/** A memo only counts if the fee wallet actually received the price, or signed it itself. */
function isValidPayment(tx: ParsedTransactionWithMeta | null, feeWallet: string) {
  if (!tx?.meta || tx.meta.err) return false
  const keys = tx.transaction.message.accountKeys
  const idx = keys.findIndex((k) => k.pubkey.toBase58() === feeWallet)
  if (idx < 0) return false
  if (idx === 0 && keys[0].signer) return true
  return tx.meta.postBalances[idx] - tx.meta.preBalances[idx] >= PRICE_LAMPORTS
}

export async function fetchPromotions(connection: Connection): Promise<Promotion[]> {
  if (!FEE_WALLET) return []
  const now = Math.floor(Date.now() / 1000)
  const sigs = await recentMemoSignatures(connection, new PublicKey(FEE_WALLET), now)
  if (!sigs.length) return []
  const parsed = await fetchParsed(connection, sigs.map((s) => s.signature))

  const payments = sigs
    .map((s, i) => ({ sig: s, tx: parsed[i] }))
    .filter(({ tx }) => isValidPayment(tx, FEE_WALLET))
    .map(({ sig, tx }) => ({
      mint: MEMO_RE.exec(sig.memo!)![1],
      signature: sig.signature,
      paidAt: sig.blockTime ?? tx!.blockTime ?? now,
      featured: tx!.transaction.message.accountKeys[0].pubkey.toBase58() === FEE_WALLET,
    }))
    .sort((a, b) => a.paidAt - b.paidAt)

  // Each payment buys PROMO_HOURS; payments during an active run extend it
  const byMint = new Map<string, Promotion>()
  for (const p of payments) {
    const prev = byMint.get(p.mint)
    const running = prev && prev.expiresAt > p.paidAt
    byMint.set(p.mint, {
      mint: p.mint,
      signature: p.signature,
      paidAt: p.paidAt,
      expiresAt: (running ? prev.expiresAt : p.paidAt) + PROMO_HOURS * 3600,
      boosts: running ? prev.boosts + 1 : 1,
      featured: p.featured || (running ? prev.featured : false),
    })
  }

  return [...byMint.values()]
    .filter((p) => p.expiresAt > now && !PROMO_BLOCKLIST.has(p.mint))
    .sort((a, b) => b.paidAt - a.paidAt)
}

export function timeLeft(expiresAt: number) {
  const s = Math.max(0, expiresAt - Math.floor(Date.now() / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`
}
