import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js'
import Decimal from 'decimal.js'
import { isOwner } from './promote'
import { splitFee, toLamports } from './referral'
import { AIRDROP_FEE_SOL, type Network } from './settings'

// Airdrop tool: send one token to a list of wallets. Each transaction creates the recipient's token
// account if needed (idempotent) and transfers; the sender pays the account rent for new holders.

export const RECIPIENTS_PER_TX = 7
/** Rent-exempt minimum of a token account (165 bytes) */
export const ATA_RENT_LAMPORTS = 2_039_280
const BASE_FEE_LAMPORTS = 5_000
const PRIORITY_MICROLAMPORTS = 100_000
const CU_PER_RECIPIENT = 40_000

export interface Recipient {
  address: string
  /** Human-readable amount (e.g. "1000.5") */
  amount: string
}

export interface ParsedList {
  valid: Recipient[]
  invalid: { line: number; text: string; reason: string }[]
  duplicates: number
}

/** Accepts "address", "address,amount", "address amount" or "address;amount" per line (CSV exports work). */
export function parseRecipients(text: string, defaultAmount: string, exclude: string[] = []): ParsedList {
  const valid: Recipient[] = []
  const invalid: ParsedList['invalid'] = []
  const seen = new Set<string>()
  let duplicates = 0
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#') || /^address\b/i.test(line)) return
    const [address, amountRaw] = line.split(/[\s,;\t]+/)
    let key: PublicKey
    try {
      key = new PublicKey(address)
    } catch {
      return invalid.push({ line: i + 1, text: line, reason: 'Not a Solana address' })
    }
    // Off-curve addresses are program-owned (PDAs, pools) — tokens sent there are usually lost
    if (!PublicKey.isOnCurve(key.toBytes())) return invalid.push({ line: i + 1, text: line, reason: 'Not a wallet (program address)' })
    const amount = (amountRaw ?? defaultAmount).trim()
    try {
      if (!new Decimal(amount).gt(0)) throw new Error()
    } catch {
      return invalid.push({ line: i + 1, text: line, reason: amountRaw ? 'Invalid amount' : 'No amount (set a default amount)' })
    }
    const addr = key.toBase58()
    if (exclude.includes(addr)) return invalid.push({ line: i + 1, text: line, reason: 'Your own wallet' })
    if (seen.has(addr)) return void duplicates++
    seen.add(addr)
    valid.push({ address: addr, amount })
  })
  return { valid, invalid, duplicates }
}

export interface MintInfo {
  mint: PublicKey
  programId: PublicKey
  decimals: number
}

export async function loadMint(connection: Connection, mint: string): Promise<MintInfo> {
  const key = new PublicKey(mint)
  const info = await connection.getParsedAccountInfo(key)
  const data = info.value?.data
  if (!info.value || !data || !('parsed' in data) || data.parsed.type !== 'mint') throw new Error('Not a token mint')
  return { mint: key, programId: info.value.owner, decimals: data.parsed.info.decimals as number }
}

export function toRawAmount(amount: string, decimals: number) {
  return BigInt(new Decimal(amount).mul(new Decimal(10).pow(decimals)).toFixed(0, Decimal.ROUND_DOWN))
}

/** Sender's balance of the token (raw units) */
export async function tokenBalance(connection: Connection, owner: PublicKey, m: MintInfo) {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: m.mint })
  return res.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount as string), 0n)
}

/** How many recipients still need a token account (= rent the sender pays). */
export async function countNewAccounts(connection: Connection, m: MintInfo, recipients: Recipient[]) {
  let missing = 0
  for (let i = 0; i < recipients.length; i += 100) {
    const atas = recipients
      .slice(i, i + 100)
      .map((r) => getAssociatedTokenAddressSync(m.mint, new PublicKey(r.address), false, m.programId))
    const infos = await connection.getMultipleAccountsInfo(atas)
    missing += infos.filter((a) => !a).length
  }
  return missing
}

export function platformFee(recipientCount: number, sender: PublicKey | null) {
  if (!AIRDROP_FEE_SOL || isOwner(sender)) return 0
  return Math.ceil(recipientCount / 100) * AIRDROP_FEE_SOL
}

export function estimateCost(recipientCount: number, newAccounts: number, network: Network, sender: PublicKey | null) {
  const txs = Math.ceil(recipientCount / RECIPIENTS_PER_TX)
  const priority = network === 'mainnet' ? Math.ceil((CU_PER_RECIPIENT * RECIPIENTS_PER_TX * PRIORITY_MICROLAMPORTS) / 1e6) : 0
  const networkLamports = txs * (BASE_FEE_LAMPORTS + priority)
  return {
    txs,
    rentSol: (newAccounts * ATA_RENT_LAMPORTS) / 1e9,
    networkSol: networkLamports / 1e9,
    platformSol: platformFee(recipientCount, sender),
  }
}

/** One transaction per RECIPIENTS_PER_TX recipients; the platform fee rides in the first one. */
export function buildAirdropTxs(
  sender: PublicKey,
  m: MintInfo,
  recipients: Recipient[],
  network: Network,
  referrer: PublicKey | null,
  totalRecipients = recipients.length,
  includeFee = true,
) {
  const source = getAssociatedTokenAddressSync(m.mint, sender, false, m.programId)
  const txs: { tx: Transaction; recipients: Recipient[] }[] = []
  for (let i = 0; i < recipients.length; i += RECIPIENTS_PER_TX) {
    const batch = recipients.slice(i, i + RECIPIENTS_PER_TX)
    const tx = new Transaction()
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_PER_RECIPIENT * batch.length + 20_000 }))
    if (network === 'mainnet') tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS }))
    const fee = platformFee(totalRecipients, sender)
    if (i === 0 && includeFee && fee > 0) {
      for (const p of splitFee(toLamports(fee), referrer)) {
        tx.add(SystemProgram.transfer({ fromPubkey: sender, toPubkey: p.to, lamports: p.lamports }))
      }
    }
    for (const r of batch) {
      const owner = new PublicKey(r.address)
      const ata = getAssociatedTokenAddressSync(m.mint, owner, false, m.programId)
      tx.add(createAssociatedTokenAccountIdempotentInstruction(sender, ata, owner, m.mint, m.programId))
      tx.add(createTransferCheckedInstruction(source, m.mint, ata, sender, toRawAmount(r.amount, m.decimals), m.decimals, [], m.programId))
    }
    txs.push({ tx, recipients: batch })
  }
  return txs
}
