/**
 * Airdrop checks without spending anything:
 *  1. List parsing (formats, invalid/program addresses, duplicates, default amount, own wallet).
 *  2. Simulates real airdrop batches on mainnet (sigVerify off) from an existing token holder
 *     to brand-new wallets — worst case: every recipient needs a new token account, plus the fee transfer.
 *
 *   VITE_FEE_WALLET=<fee wallet> npx tsx scripts/airdrop-test.ts
 */
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'

const RPC = process.env.MAINNET_RPC || 'https://api.mainnet-beta.solana.com'
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
let failed = false
const check = (ok: boolean, msg: string) => {
  if (!ok) failed = true
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}

const { parseRecipients, buildAirdropTxs, loadMint, estimateCost, RECIPIENTS_PER_TX } = await import('../src/lib/airdrop')
const connection = new Connection(RPC, 'confirmed')

// ---- 1. Parser ----
const a = Keypair.generate().publicKey.toBase58()
const b = Keypair.generate().publicKey.toBase58()
const me = Keypair.generate().publicKey.toBase58()
const pda = getAssociatedTokenAddressSync(new PublicKey(BONK), new PublicKey(a)).toBase58()
const list = parseRecipients(
  ['address,amount', `${a},250`, `${b}`, `${a};99`, 'not-an-address', `${pda},5`, `${me},1`, `${b.slice(0, 20)}`, '', '# comment'].join('\n'),
  '100',
  [me],
)
check(list.valid.length === 2 && list.valid[0].amount === '250' && list.valid[1].amount === '100', 'explicit amount kept, default amount applied')
check(list.duplicates === 1, 'duplicate address counted once')
check(list.invalid.some((x) => x.reason.includes('program')), 'program/PDA address rejected')
check(list.invalid.some((x) => x.reason === 'Your own wallet'), 'own wallet excluded')
check(list.invalid.filter((x) => x.reason === 'Not a Solana address').length === 2, 'garbage lines rejected')
check(parseRecipients(`${a}`, '').invalid[0]?.reason.includes('default amount'), 'missing amount without default → error')

// ---- 2. Simulate batches on mainnet ----
// Find a system-owned wallet that holds BONK and some SOL (via recent BONK transfers)
const sigs = await connection.getSignaturesForAddress(new PublicKey(BONK), { limit: 30 })
let sender: PublicKey | null = null
for (const s of sigs) {
  const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
  for (const bal of tx?.meta?.postTokenBalances || []) {
    if (bal.mint !== BONK || !bal.owner || Number(bal.uiTokenAmount.uiAmount) < 1000) continue
    if (!PublicKey.isOnCurve(new PublicKey(bal.owner).toBytes())) continue // skip multisig vaults / PDAs
    const info = await connection.getAccountInfo(new PublicKey(bal.owner))
    if (info?.owner.equals(new PublicKey('11111111111111111111111111111111')) && info.lamports > 0.2e9) {
      sender = new PublicKey(bal.owner)
      break
    }
  }
  if (sender) break
}
if (!sender) throw new Error('No funded BONK holder found for simulation')
console.log('Simulating as BONK holder', sender.toBase58())

const mint = await loadMint(connection, BONK)
const recipients = Array.from({ length: RECIPIENTS_PER_TX * 2 }, () => ({ address: Keypair.generate().publicKey.toBase58(), amount: '1' }))
const batches = buildAirdropTxs(sender, mint, recipients, 'mainnet', Keypair.generate().publicKey)
check(batches.length === 2, `${recipients.length} recipients → ${batches.length} transactions`)
for (const [i, { tx }] of batches.entries()) {
  const { blockhash } = await connection.getLatestBlockhash()
  const msg = new TransactionMessage({ payerKey: sender, recentBlockhash: blockhash, instructions: tx.instructions }).compileToV0Message()
  const vtx = new VersionedTransaction(msg)
  const size = vtx.serialize().length
  const res = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true })
  check(!res.value.err && size <= 1232, `batch ${i + 1}: ${size} bytes, ${res.value.unitsConsumed} CU, ${i === 0 ? 'incl. fee + referral split' : 'tokens only'}`)
  if (res.value.err) console.log('   ', JSON.stringify(res.value.err), (res.value.logs || []).slice(-6))
}
// The app sends legacy transactions — make sure the largest batch also fits that format
const legacy = batches[0].tx
legacy.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
legacy.feePayer = sender
const legacySize = legacy.serialize({ requireAllSignatures: false, verifySignatures: false }).length
check(legacySize <= 1232, `legacy transaction size ${legacySize} bytes (limit 1232)`)

const cost = estimateCost(1000, 1000, 'mainnet', sender)
console.log(`Cost for 1000 new recipients: ${cost.txs} txs, rent ${cost.rentSol.toFixed(2)} SOL, network ${cost.networkSol.toFixed(4)} SOL, platform ${cost.platformSol} SOL`)

console.log(failed ? '\nFAILED' : '\nAll airdrop checks passed ✔')
process.exit(failed ? 1 : 0)
