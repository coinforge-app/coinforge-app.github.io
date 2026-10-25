import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { FEE_WALLET, REF_PERCENT } from './settings'

// "Trader werben Trader": a visit via ?ref=<wallet> is remembered for 30 days in this browser.
// Every platform fee paid afterwards is split in the same transaction: REF_PERCENT to the referrer.

const KEY = 'cf.ref'
const TTL_MS = 30 * 24 * 3600 * 1000
// A transfer that creates a new (empty) account must leave it rent-exempt (~0.00089 SOL)
const MIN_REF_LAMPORTS = 1_000_000

function isWallet(s: string) {
  try {
    return PublicKey.isOnCurve(new PublicKey(s).toBytes())
  } catch {
    return false
  }
}

/** Reads ?ref= from the URL (query or hash query). First referrer wins until it expires. */
export function captureReferral() {
  const fromSearch = new URLSearchParams(window.location.search).get('ref')
  const fromHash = new URLSearchParams(window.location.hash.split('?')[1] || '').get('ref')
  const ref = (fromSearch || fromHash || '').trim()
  if (!ref || !isWallet(ref) || ref === FEE_WALLET) return
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || 'null') as { ref: string; at: number } | null
    if (stored && Date.now() - stored.at < TTL_MS) return
    localStorage.setItem(KEY, JSON.stringify({ ref, at: Date.now() }))
  } catch {
    /* storage unavailable: referral simply isn't tracked */
  }
}

/** The active referrer for this payer, or null (none, expired, self-referral or the owner). */
export function getReferrer(payer: PublicKey | null): PublicKey | null {
  if (!REF_PERCENT || !FEE_WALLET) return null
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) || 'null') as { ref: string; at: number } | null
    if (!stored || Date.now() - stored.at > TTL_MS) return null
    if (payer && stored.ref === payer.toBase58()) return null
    if (payer?.toBase58() === FEE_WALLET) return null
    return new PublicKey(stored.ref)
  } catch {
    return null
  }
}

/** Splits a fee between the fee wallet and an optional referrer (integer lamports, no rounding loss). */
export function splitFee(totalLamports: number, referrer: PublicKey | null) {
  const refLamports = referrer ? Math.floor((totalLamports * REF_PERCENT) / 100) : 0
  const payouts = [] as { to: PublicKey; lamports: number }[]
  if (referrer && refLamports >= MIN_REF_LAMPORTS) {
    payouts.push({ to: new PublicKey(FEE_WALLET), lamports: totalLamports - refLamports })
    payouts.push({ to: referrer, lamports: refLamports })
  } else {
    payouts.push({ to: new PublicKey(FEE_WALLET), lamports: totalLamports })
  }
  return payouts
}

export const toLamports = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL)

export function referralLink(wallet: PublicKey) {
  return `${window.location.origin}${window.location.pathname}?ref=${wallet.toBase58()}`
}
