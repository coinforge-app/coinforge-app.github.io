import { PublicKey, type Connection, type ParsedInstruction, type PartiallyDecodedInstruction } from '@solana/web3.js'
import { fetchParsed, MEMO_RE } from './promote'
import { FEE_WALLET } from './settings'

// Owner dashboard: classifies incoming fee-wallet transactions straight from chain history.

const TOKEN_METADATA = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'

export interface EarningTx {
  signature: string
  time: number
  kind: 'token' | 'promotion' | 'other'
  payer: string
  /** Lamports received by the fee wallet */
  toYou: number
  /** Lamports paid to a referrer in the same transaction */
  toReferrer: number
  referrer?: string
}

export async function fetchEarnings(connection: Connection, maxTx = 2000): Promise<EarningTx[]> {
  if (!FEE_WALLET) return []
  const fee = new PublicKey(FEE_WALLET)
  const sigs = []
  let before: string | undefined
  while (sigs.length < maxTx) {
    const batch = await connection.getSignaturesForAddress(fee, { limit: 1000, before })
    sigs.push(...batch.filter((s) => !s.err))
    if (batch.length < 1000) break
    before = batch[batch.length - 1].signature
  }
  const parsed = await fetchParsed(connection, sigs.map((s) => s.signature))

  const out: EarningTx[] = []
  sigs.forEach((sig, i) => {
    const tx = parsed[i]
    if (!tx?.meta) return
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58())
    const payer = keys[0]
    const idx = keys.indexOf(FEE_WALLET)
    if (payer === FEE_WALLET || idx < 0) return // own transactions are not income
    const toYou = tx.meta.postBalances[idx] - tx.meta.preBalances[idx]
    if (toYou <= 0) return

    // Referral share = top-level SOL transfers from the payer to anyone but the fee wallet
    let toReferrer = 0
    let referrer: string | undefined
    for (const ix of tx.transaction.message.instructions as (ParsedInstruction | PartiallyDecodedInstruction)[]) {
      if (!('parsed' in ix) || ix.program !== 'system' || ix.parsed?.type !== 'transfer') continue
      const info = ix.parsed.info as { source: string; destination: string; lamports: number }
      if (info.source === payer && info.destination !== FEE_WALLET) {
        toReferrer += info.lamports
        referrer = info.destination
      }
    }

    out.push({
      signature: sig.signature,
      time: sig.blockTime ?? tx.blockTime ?? 0,
      kind: sig.memo && MEMO_RE.test(sig.memo) ? 'promotion' : keys.includes(TOKEN_METADATA) ? 'token' : 'other',
      payer,
      toYou,
      toReferrer,
      referrer,
    })
  })
  return out
}
