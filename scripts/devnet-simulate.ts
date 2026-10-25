/**
 * Zero-cost check of the transactions the UI builds: they are simulated on devnet
 * (sigVerify off) with an existing funded account as payer. Nothing is broadcast.
 *
 *   npx tsx scripts/devnet-simulate.ts
 */
import { Connection, Keypair, PublicKey, VersionedTransaction, type Transaction } from '@solana/web3.js'
import { createNoopSigner, generateSigner, publicKey, signerIdentity, sol } from '@metaplex-foundation/umi'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata'
import { mplToolbox, transferSol } from '@metaplex-foundation/mpl-toolbox'
import { buildCreateTokenTx, type TokenForm } from '../src/lib/createToken'
import { getFeeConfigs, getLpBalance, getMintInfo, loadRaydium, toRaw, WSOL_MINT, cpmmProgram } from '../src/lib/raydium'
import { DEVNET_PROGRAM_ID, Percent, TxVersion } from '@raydium-io/raydium-sdk-v2'
import BN from 'bn.js'

const RPC = process.env.DEVNET_RPC || 'https://api.devnet.solana.com'
const connection = new Connection(RPC, 'confirmed')
let failed = false

async function simulate(label: string, tx: VersionedTransaction) {
  const size = tx.serialize().length
  const res = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })
  const ok = !res.value.err
  if (!ok) failed = true
  console.log(`${ok ? '✓' : '✗'} ${label} — ${size} bytes, ${res.value.unitsConsumed} CU`)
  if (!ok) console.log('   err:', JSON.stringify(res.value.err), '\n  ', (res.value.logs || []).slice(-8).join('\n   '))
}

/** A system-owned devnet account with enough SOL to act as fee payer in simulation. */
async function findFundedPayer(minLamports: number, holdingMint?: string) {
  if (holdingMint) {
    // Recent transfers of the mint reveal holders (getTokenLargestAccounts is heavily rate-limited on public devnet)
    const sigs = await connection.getSignaturesForAddress(new PublicKey(holdingMint), { limit: 40 })
    const seen = new Set<string>()
    for (const s of sigs) {
      const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
      for (const b of tx?.meta?.postTokenBalances || []) {
        if (b.mint !== holdingMint || !b.owner || seen.has(b.owner) || Number(b.uiTokenAmount.uiAmount) < 2) continue
        seen.add(b.owner)
        const ownerInfo = await connection.getAccountInfo(new PublicKey(b.owner))
        if (ownerInfo?.owner.equals(new PublicKey('11111111111111111111111111111111')) && ownerInfo.lamports >= minLamports)
          return { owner: new PublicKey(b.owner), tokenAmount: b.uiTokenAmount.uiAmountString! }
      }
    }
    throw new Error('No suitable holder found')
  }
  const sigs = await connection.getSignaturesForAddress(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), { limit: 25 })
  for (const s of sigs) {
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
    const payer = tx?.transaction.message.staticAccountKeys[0]
    if (!payer) continue
    const info = await connection.getAccountInfo(payer)
    if (info?.owner.equals(new PublicKey('11111111111111111111111111111111')) && info.lamports >= minLamports) return { owner: payer }
  }
  throw new Error('No funded payer found')
}

async function main() {
  // ---- Token creation: worst case (all add-ons + platform fee transfer) ----
  const { owner: payer } = await findFundedPayer(0.1e9)
  console.log('Simulating as', payer.toBase58())
  const umi = createUmi(RPC).use(mplTokenMetadata()).use(mplToolbox()).use(signerIdentity(createNoopSigner(publicKey(payer.toBase58()))))
  const form: TokenForm = {
    name: 'A'.repeat(32),
    symbol: 'B'.repeat(10),
    image: null,
    decimals: 9,
    supply: '1000000000',
    description: '',
    website: '',
    twitter: '',
    telegram: '',
    discord: '',
    customCreator: true,
    creatorName: 'x',
    creatorWebsite: '',
    revokeFreeze: true,
    revokeMint: true,
    revokeUpdate: true,
  }
  const uri = 'https://gateway.irys.xyz/' + 'x'.repeat(43)
  for (const network of ['devnet', 'mainnet'] as const) {
    const mint = generateSigner(umi)
    // Worst case: platform fee split with a referrer + an extra transfer
    let builder = buildCreateTokenTx(umi, network, form, mint, uri, Keypair.generate().publicKey)
    // Platform fee is env-driven; add it explicitly to test the largest transaction
    builder = builder.prepend(transferSol(umi, { destination: publicKey(payer.toBase58()), amount: sol(0.001) }))
    const parts = builder.unsafeSplitByTransactionSize(umi)
    console.log(`Token tx (${network} flags, fee + 3 revokes) → ${parts.length} transaction(s)`)
    for (const [i, part] of parts.entries()) {
      const built = await part.buildWithLatestBlockhash(umi)
      await simulate(`create token part ${i + 1}`, VersionedTransaction.deserialize(umi.transactions.serialize(built)))
    }
  }

  // ---- Raydium CPMM pool creation with a real devnet token holder ----
  const DEV_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
  const holder = await findFundedPayer(1e9, DEV_USDC)
  console.log('\nPool creator', holder.owner.toBase58(), 'holds', holder.tokenAmount, 'devUSDC')
  const noopSign = async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs
  const raydium = await loadRaydium(connection, holder.owner, noopSign, 'devnet')
  const configs = await getFeeConfigs(raydium, 'devnet')
  console.log('Fee tiers:', configs.map((c) => `${c.tradeFeeRate / 10000}% (idx ${c.index}, create fee ${Number(c.createPoolFee) / 1e9} SOL)`).join(', '))
  const mint = await getMintInfo(connection, DEV_USDC)
  // Pool PDA is unique per (config, mints) — pick a tier where no devUSDC/SOL pool exists yet
  for (const feeConfig of configs) {
    const { transaction, extInfo } = await raydium.cpmm.createPool({
      programId: cpmmProgram('devnet'),
      poolFeeAccount: DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
      mintA: { address: mint.address, decimals: mint.decimals, programId: mint.programId },
      mintB: { address: WSOL_MINT, decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
      mintAAmount: toRaw('1', mint.decimals),
      mintBAmount: toRaw('0.01', 9),
      startTime: new BN(0),
      feeConfig,
      associatedOnly: false,
      ownerInfo: { useSOLBalance: true },
      txVersion: TxVersion.V0,
    })
    if (await connection.getAccountInfo(extInfo.address.poolId)) {
      console.log(`  tier ${feeConfig.tradeFeeRate / 10000}%: pool already exists, trying next`)
      continue
    }
    await simulate(`create CPMM pool (tier ${feeConfig.tradeFeeRate / 10000}%)`, transaction)
    break
  }

  // ---- Remove liquidity: find a devnet CPMM pool and one of its LP holders ----
  const cpmmSigs = await connection.getSignaturesForAddress(cpmmProgram('devnet'), { limit: 15 })
  let withdrawn = false
  outer: for (const s of cpmmSigs) {
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
    if (!tx || tx.meta?.err) continue
    for (const key of tx.transaction.message.staticAccountKeys) {
      const info = await connection.getAccountInfo(key)
      if (!info?.owner.equals(cpmmProgram('devnet')) || info.data.length !== 637) continue // CPMM pool state size
      const { poolInfo } = await raydium.cpmm.getPoolInfoFromRpc(key.toBase58()).catch(() => ({ poolInfo: null }))
      if (!poolInfo || poolInfo.lpAmount <= 0) continue
      const lpSigs = await connection.getSignaturesForAddress(new PublicKey(poolInfo.lpMint.address), { limit: 10 })
      for (const ls of lpSigs) {
        const ltx = await connection.getTransaction(ls.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
        for (const b of ltx?.meta?.postTokenBalances || []) {
          if (b.mint !== poolInfo.lpMint.address || !b.owner) continue
          const lpOwner = new PublicKey(b.owner)
          const lp = await getLpBalance(connection, lpOwner, b.mint)
          if (lp < 2n) continue
          console.log(`\nLP holder ${lpOwner.toBase58()} in pool ${key.toBase58()} (${lp} LP)`)
          const r2 = await loadRaydium(connection, lpOwner, noopSign, 'devnet')
          const { transaction } = await r2.cpmm.withdrawLiquidity({
            poolInfo,
            lpAmount: new BN((lp / 2n).toString()),
            slippage: new Percent(1, 100),
            txVersion: TxVersion.V0,
            closeWsol: true,
          })
          await simulate('remove 50% liquidity', transaction)
          withdrawn = true
          break outer
        }
      }
    }
  }
  if (!withdrawn) console.log('\n(no devnet LP holder found to simulate remove-liquidity)')

  console.log(failed ? '\nSome simulations FAILED' : '\nAll simulations passed ✔')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
