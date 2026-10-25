/**
 * Checks the homepage-promotion logic without spending anything:
 *  1. Simulates the real promote transaction on mainnet (sigVerify off), as a normal user and as the owner.
 *  2. Runs fetchPromotions() against a fake RPC to verify payment checks, expiry and stacking.
 *
 *   VITE_FEE_WALLET=<fee wallet> npx tsx scripts/promote-test.ts
 */
import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage } from '@solana/web3.js'

const FEE = process.env.VITE_FEE_WALLET
if (!FEE) throw new Error('Set VITE_FEE_WALLET')
const RPC = process.env.MAINNET_RPC || 'https://api.mainnet-beta.solana.com'
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
let failed = false
const check = (ok: boolean, msg: string) => {
  if (!ok) failed = true
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}

const { buildPromoteTx, fetchPromotions, checkMint } = await import('../src/lib/promote')
const connection = new Connection(RPC, 'confirmed')

// ---- 1. On-chain simulation ----
async function simulate(label: string, payer: PublicKey) {
  const tx = buildPromoteTx(payer, BONK, 'mainnet')
  const { blockhash } = await connection.getLatestBlockhash()
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: tx.instructions }).compileToV0Message()
  const res = await connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true })
  const memoLogged = (res.value.logs || []).some((l) => l.includes(`coinforge:promote:${BONK}`))
  check(!res.value.err && memoLogged, `${label}: ${tx.instructions.length} instructions, ${res.value.unitsConsumed} CU, memo logged`)
  if (res.value.err) console.log('   ', JSON.stringify(res.value.err), (res.value.logs || []).slice(-5))
  return tx
}

await checkMint(connection, BONK)
check(true, 'checkMint accepts a real mint')
try {
  await checkMint(connection, FEE)
  check(false, 'checkMint rejects a wallet address')
} catch {
  check(true, 'checkMint rejects a wallet address')
}

// A funded system account to stand in for a paying user
const sigs = await connection.getSignaturesForAddress(new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), { limit: 20 })
let user: PublicKey | null = null
for (const s of sigs) {
  const t = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
  const k = t?.transaction.message.staticAccountKeys[0]
  if (!k) continue
  const info = await connection.getAccountInfo(k)
  if (info?.owner.equals(new PublicKey('11111111111111111111111111111111')) && info.lamports > 0.1e9) {
    user = k
    break
  }
}
if (!user) throw new Error('no funded account found for simulation')
const userTx = await simulate('user pays 0.05 SOL', user)
check(userTx.instructions.some((i) => i.programId.equals(new PublicKey('11111111111111111111111111111111'))), 'user tx contains SOL transfer')
const ownerTx = buildPromoteTx(new PublicKey(FEE), BONK, 'mainnet')
check(!ownerTx.instructions.some((i) => i.programId.equals(new PublicKey('11111111111111111111111111111111'))), 'owner tx has no transfer (free)')
const feeBal = await connection.getBalance(new PublicKey(FEE))
if (feeBal > 0.0001e9) await simulate('owner promotes for free', new PublicKey(FEE))
else console.log(`- owner simulation skipped (fee wallet balance ${feeBal / 1e9} SOL)`)

// ---- 2. Promotion list logic against a fake RPC ----
const now = Math.floor(Date.now() / 1000)
const H = 3600
const feeKey = new PublicKey(FEE)
const userKey = Keypair.generate().publicKey
const mints = Array.from({ length: 5 }, () => Keypair.generate().publicKey.toBase58())
type Fake = { sig: string; mint: string; payer: PublicKey; lamports: number; at: number; err?: boolean }
const fakes: Fake[] = [
  { sig: 'paid', mint: mints[0], payer: userKey, lamports: 0.05e9, at: now - 2 * H },
  { sig: 'underpaid', mint: mints[1], payer: userKey, lamports: 0.01e9, at: now - 1 * H },
  { sig: 'owner', mint: mints[2], payer: feeKey, lamports: 0, at: now - 3 * H },
  { sig: 'expired', mint: mints[3], payer: userKey, lamports: 0.05e9, at: now - 30 * H },
  { sig: 'stack1', mint: mints[4], payer: userKey, lamports: 0.05e9, at: now - 20 * H },
  { sig: 'stack2', mint: mints[4], payer: userKey, lamports: 0.05e9, at: now - 10 * H },
  { sig: 'failed', mint: mints[1], payer: userKey, lamports: 0.05e9, at: now - 1 * H, err: true },
]
const fakeConnection = {
  getSignaturesForAddress: async () =>
    fakes
      .slice()
      .sort((a, b) => b.at - a.at)
      .map((f) => ({ signature: f.sig, slot: 0, err: f.err ? {} : null, memo: `[60] coinforge:promote:${f.mint}`, blockTime: f.at })),
  getParsedTransactions: async (list: string[]) =>
    list.map((sig) => {
      const f = fakes.find((x) => x.sig === sig)!
      const ownerTx = f.payer.equals(feeKey)
      const accountKeys = ownerTx
        ? [{ pubkey: feeKey, signer: true, writable: true }]
        : [
            { pubkey: f.payer, signer: true, writable: true },
            { pubkey: feeKey, signer: false, writable: true },
          ]
      return {
        blockTime: f.at,
        meta: { err: null, preBalances: ownerTx ? [1e9] : [1e9, 5e9], postBalances: ownerTx ? [1e9 - 5000] : [1e9 - f.lamports - 5000, 5e9 + f.lamports] },
        transaction: { message: { accountKeys } },
      }
    }),
} as unknown as Connection

const list = await fetchPromotions(fakeConnection)
const by = Object.fromEntries(list.map((p) => [p.mint, p]))
check(!!by[mints[0]] && !by[mints[0]].featured, 'paid 0.05 SOL → listed')
check(!by[mints[1]], 'underpaid / failed tx → not listed')
check(!!by[mints[2]]?.featured, 'owner memo without payment → listed as featured (free)')
check(!by[mints[3]], 'payment older than 24h → expired')
check(by[mints[4]]?.boosts === 2 && by[mints[4]].expiresAt === now - 20 * H + 48 * H, 'two overlapping payments → stacked to 48h, boosts ×2')
check(list[0]?.mint === mints[0], 'newest payment ranks #1')

console.log(failed ? '\nFAILED' : '\nAll promotion checks passed ✔')
process.exit(failed ? 1 : 0)
