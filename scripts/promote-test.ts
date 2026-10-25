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
async function simulate(label: string, payer: PublicKey, referrer: PublicKey | null = null) {
  const tx = buildPromoteTx(payer, BONK, 'mainnet', referrer)
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
// Referral: 30% of 0.05 SOL to the referrer, 70% to the fee wallet, in the same transaction
const referrer = Keypair.generate().publicKey
const refTx = await simulate('user pays via referral link', user, referrer)
const transfers = refTx.instructions
  .filter((i) => i.programId.equals(new PublicKey('11111111111111111111111111111111')))
  .map((i) => ({ to: i.keys[1].pubkey.toBase58(), lamports: Number(i.data.readBigUInt64LE(4)) }))
check(
  transfers.length === 2 && transfers[0].to === FEE && transfers[0].lamports === 35_000_000 && transfers[1].to === referrer.toBase58() && transfers[1].lamports === 15_000_000,
  `referral split 0.035 SOL → fee wallet, 0.015 SOL → referrer (${JSON.stringify(transfers.map((t) => t.lamports))})`,
)
const selfRef = buildPromoteTx(user, BONK, 'mainnet', null)
check(selfRef.instructions.filter((i) => i.programId.equals(new PublicKey('11111111111111111111111111111111'))).length === 1, 'no referrer → single 0.05 SOL transfer')
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
const mints = Array.from({ length: 6 }, () => Keypair.generate().publicKey.toBase58())
type Fake = { sig: string; mint: string; payer: PublicKey; lamports: number; at: number; err?: boolean }
const fakes: Fake[] = [
  { sig: 'paid', mint: mints[0], payer: userKey, lamports: 0.05e9, at: now - 2 * H },
  { sig: 'underpaid', mint: mints[1], payer: userKey, lamports: 0.01e9, at: now - 1 * H },
  { sig: 'owner', mint: mints[2], payer: feeKey, lamports: 0, at: now - 3 * H },
  { sig: 'expired', mint: mints[3], payer: userKey, lamports: 0.05e9, at: now - 30 * H },
  { sig: 'stack1', mint: mints[4], payer: userKey, lamports: 0.05e9, at: now - 20 * H },
  { sig: 'stack2', mint: mints[4], payer: userKey, lamports: 0.05e9, at: now - 10 * H },
  { sig: 'failed', mint: mints[1], payer: userKey, lamports: 0.05e9, at: now - 1 * H, err: true },
  { sig: 'referred', mint: mints[5], payer: userKey, lamports: 0.035e9, at: now - 0.5 * H },
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
check(!!by[mints[5]], 'referred payment (70% to fee wallet) → listed')
check(list[0]?.mint === mints[5], 'newest payment ranks #1')

// ---- 3. Earnings dashboard classification ----
const { fetchEarnings } = await import('../src/lib/earnings')
const refWallet = Keypair.generate().publicKey.toBase58()
const sysTransfer = (source: string, destination: string, lamports: number) => ({ program: 'system', programId: new PublicKey('11111111111111111111111111111111'), parsed: { type: 'transfer', info: { source, destination, lamports } } })
const earningFakes = [
  { signature: 'tok', memo: null, keys: [userKey.toBase58(), FEE, refWallet, 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'], feeDelta: 0.28e9, ix: [sysTransfer(userKey.toBase58(), FEE, 0.28e9), sysTransfer(userKey.toBase58(), refWallet, 0.12e9)] },
  { signature: 'promo', memo: `[60] coinforge:promote:${mints[0]}`, keys: [userKey.toBase58(), FEE], feeDelta: 0.05e9, ix: [sysTransfer(userKey.toBase58(), FEE, 0.05e9)] },
  { signature: 'own', memo: null, keys: [FEE, userKey.toBase58()], feeDelta: -0.1e9, ix: [] },
]
const earnConn = {
  getSignaturesForAddress: async () => earningFakes.map((f) => ({ signature: f.signature, slot: 0, err: null, memo: f.memo, blockTime: now })),
  getParsedTransactions: async (list: string[]) =>
    list.map((sig) => {
      const f = earningFakes.find((x) => x.signature === sig)!
      const idx = f.keys.indexOf(FEE)
      const pre = f.keys.map(() => 1e9)
      const post = pre.map((v, i) => (i === idx ? v + f.feeDelta : v))
      return { blockTime: now, meta: { err: null, preBalances: pre, postBalances: post }, transaction: { message: { accountKeys: f.keys.map((k, i) => ({ pubkey: new PublicKey(k), signer: i === 0, writable: true })), instructions: f.ix } } }
    }),
} as unknown as Connection
const earnings = await fetchEarnings(earnConn)
const tok = earnings.find((e) => e.signature === 'tok')
check(tok?.kind === 'token' && tok.toYou === 0.28e9 && tok.toReferrer === 0.12e9 && tok.referrer === refWallet, 'earnings: token sale with referral → you 0.28, referrer 0.12')
check(earnings.find((e) => e.signature === 'promo')?.kind === 'promotion', 'earnings: promotion classified')
check(!earnings.find((e) => e.signature === 'own'), 'earnings: own outgoing tx ignored')

console.log(failed ? '\nFAILED' : '\nAll promotion checks passed ✔')
process.exit(failed ? 1 : 0)
