/**
 * Simulates a Raydium Burn & Earn liquidity lock (with the platform fee attached) on devnet using an
 * existing CPMM pool and one of its LP holders, and checks the lock-vault derivation used for trust badges.
 *
 *   npx tsx scripts/lock-test.ts
 */
import { Connection, Keypair, PublicKey, SystemProgram, type Transaction, type VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DEVNET_PROGRAM_ID, TxVersion } from '@raydium-io/raydium-sdk-v2'
import BN from 'bn.js'
import { cpmmProgram, getLpBalance, liquidityTrust, loadRaydium } from '../src/lib/raydium'

const connection = new Connection(process.env.DEVNET_RPC || 'https://api.devnet.solana.com', 'confirmed')
let failed = false
const check = (ok: boolean, msg: string) => {
  if (!ok) failed = true
  console.log(`${ok ? '✓' : '✗'} ${msg}`)
}
const noopSign = async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs

// Find a devnet CPMM pool with an LP holder (same approach as devnet-simulate)
const sigs = await connection.getSignaturesForAddress(cpmmProgram('devnet'), { limit: 20 })
let found: { pool: string; holder: PublicKey; lp: bigint } | null = null
const probe = await loadRaydium(connection, Keypair.generate().publicKey, noopSign, 'devnet')
outer: for (const s of sigs) {
  const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
  if (!tx || tx.meta?.err) continue
  for (const key of tx.transaction.message.staticAccountKeys) {
    const info = await connection.getAccountInfo(key)
    if (!info?.owner.equals(cpmmProgram('devnet')) || info.data.length !== 637) continue
    const { poolInfo } = await probe.cpmm.getPoolInfoFromRpc(key.toBase58()).catch(() => ({ poolInfo: null }))
    if (!poolInfo) continue
    const lpSigs = await connection.getSignaturesForAddress(new PublicKey(poolInfo.lpMint.address), { limit: 10 })
    for (const ls of lpSigs) {
      const ltx = await connection.getTransaction(ls.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
      for (const b of ltx?.meta?.postTokenBalances || []) {
        if (b.mint !== poolInfo.lpMint.address || !b.owner || !PublicKey.isOnCurve(new PublicKey(b.owner).toBytes())) continue
        const lp = await getLpBalance(connection, new PublicKey(b.owner), b.mint)
        if (lp > 1000n) {
          found = { pool: key.toBase58(), holder: new PublicKey(b.owner), lp }
          break outer
        }
      }
    }
  }
}
if (!found) throw new Error('No devnet LP holder found')
console.log(`Pool ${found.pool}, LP holder ${found.holder.toBase58()} (${found.lp} LP)`)

const raydium = await loadRaydium(connection, found.holder, noopSign, 'devnet')
const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(found.pool)
const { builder, extInfo } = await raydium.cpmm.lockLp({
  poolInfo,
  poolKeys,
  lpAmount: new BN((found.lp / 2n).toString()),
  withMetadata: true,
  txVersion: TxVersion.LEGACY,
  programId: DEVNET_PROGRAM_ID.LOCK_CPMM_PROGRAM,
  authProgram: DEVNET_PROGRAM_ID.LOCK_CPMM_AUTH,
})
// Platform fee + referral split attached exactly like the app does
builder.addInstruction({
  instructions: [
    SystemProgram.transfer({ fromPubkey: found.holder, toPubkey: Keypair.generate().publicKey, lamports: 23_100_000 }),
    SystemProgram.transfer({ fromPubkey: found.holder, toPubkey: Keypair.generate().publicKey, lamports: 9_900_000 }),
  ],
})
const { transaction, signers } = builder.build()
const latest = await connection.getLatestBlockhash()
transaction.recentBlockhash = latest.blockhash
transaction.feePayer = found.holder
if (signers.length) transaction.partialSign(...signers)
const size = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length
const sim = await connection.simulateTransaction(transaction.compileMessage(), undefined)
  .catch(async () => connection.simulateTransaction(transaction))
check(!sim.value.err && size <= 1232, `lock 50% LP + fee transfer: ${size} bytes, ${sim.value.unitsConsumed} CU`)
if (sim.value.err) console.log('   ', JSON.stringify(sim.value.err), (sim.value.logs || []).slice(-6))

const derived = getAssociatedTokenAddressSync(new PublicKey(poolInfo.lpMint.address), DEVNET_PROGRAM_ID.LOCK_CPMM_AUTH, true)
check(derived.equals(extInfo.lockLpVault), `lock vault = ATA(lpMint, lock authority) → trust badge reads the right account`)

const trust = await liquidityTrust(connection, 'devnet', poolInfo)
check(Number.isFinite(trust.lockedPct) && Number.isFinite(trust.burnedPct), `trust: ${trust.lockedPct.toFixed(2)}% locked, ${trust.burnedPct.toFixed(2)}% burned`)

console.log(failed ? '\nFAILED' : '\nAll lock checks passed ✔')
process.exit(failed ? 1 : 0)
