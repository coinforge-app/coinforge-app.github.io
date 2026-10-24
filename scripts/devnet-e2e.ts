/**
 * Devnet end-to-end check of the on-chain logic used by the UI:
 * create token (+ revoke mint/freeze/update) → create Raydium CPMM pool → remove 50% liquidity.
 *
 *   npx tsx scripts/devnet-e2e.ts
 *
 * Uses a throwaway keypair in scripts/.devnet-keypair.json (funded via devnet airdrop).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, VersionedTransaction } from '@solana/web3.js'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { keypairIdentity, publicKey } from '@metaplex-foundation/umi'
import { fromWeb3JsKeypair } from '@metaplex-foundation/umi-web3js-adapters'
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys/node'
import { fetchMetadataFromSeeds, mplTokenMetadata } from '@metaplex-foundation/mpl-token-metadata'
import { mplToolbox } from '@metaplex-foundation/mpl-toolbox'
import { createToken, type TokenForm } from '../src/lib/createToken'
import { createPool, getFeeConfigs, getLpBalance, getMintInfo, getPool, loadRaydium, removeLiquidity } from '../src/lib/raydium'

const RPC = process.env.DEVNET_RPC || 'https://api.devnet.solana.com'
const KEY_FILE = new URL('./.devnet-keypair.json', import.meta.url)

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`)
  console.log(`  ✓ ${msg}`)
}

async function main() {
  const kp = existsSync(KEY_FILE)
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY_FILE, 'utf8'))))
    : Keypair.generate()
  if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, JSON.stringify([...kp.secretKey]))
  const connection = new Connection(RPC, 'confirmed')
  console.log('Wallet:', kp.publicKey.toBase58())

  let balance = await connection.getBalance(kp.publicKey)
  if (balance < 1.2 * LAMPORTS_PER_SOL) {
    console.log('Requesting devnet airdrop…')
    try {
      const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL)
      await connection.confirmTransaction(sig, 'confirmed')
    } catch (e) {
      console.error(`Airdrop failed (${(e as Error).message}). Fund ${kp.publicKey.toBase58()} at https://faucet.solana.com and re-run.`)
      process.exit(1)
    }
    balance = await connection.getBalance(kp.publicKey)
  }
  console.log('Balance:', balance / LAMPORTS_PER_SOL, 'SOL')

  // --- 1. Token creation (same createToken() the UI calls) ---
  const umi = createUmi(RPC)
    .use(mplTokenMetadata())
    .use(mplToolbox())
    .use(keypairIdentity(fromWeb3JsKeypair(kp)))
    .use(irysUploader({ address: 'https://devnet.irys.xyz', providerUrl: RPC }))

  // 1x1 green PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
  const form: TokenForm = {
    name: 'Forge E2E',
    symbol: 'FE2E',
    image: new File([png], 'logo.png', { type: 'image/png' }),
    decimals: 9,
    supply: '1000000000',
    description: 'CoinForge devnet end-to-end test token',
    website: 'https://example.com',
    twitter: '',
    telegram: '',
    discord: '',
    customCreator: true,
    creatorName: 'E2E',
    creatorWebsite: 'https://example.com',
    revokeFreeze: true,
    revokeMint: true,
    revokeUpdate: true,
  }
  console.log('\n[1] Creating token…')
  const token = await createToken(umi, 'devnet', form, (s) => console.log('   ', s))
  console.log('    mint:', token.mint, '\n    uri:', token.uri)

  const mint = await getMintInfo(connection, token.mint)
  assert(mint.mintAuthority === null, 'mint authority revoked')
  assert(mint.freezeAuthority === null, 'freeze authority revoked')
  assert(mint.supply === (BigInt(form.supply) * 10n ** BigInt(form.decimals)).toString(), 'full supply minted')
  const md = await fetchMetadataFromSeeds(umi, { mint: publicKey(token.mint) })
  assert(md.isMutable === false, 'metadata immutable (update authority revoked)')
  assert(md.name === form.name && md.symbol === form.symbol, 'name & symbol on-chain')
  const json = await (await fetch(token.uri)).json()
  assert(json.image === token.imageUri && json.website === form.website, 'metadata JSON uploaded with image + socials')

  // --- 2. Raydium CPMM pool ---
  const signAll = async <T extends Transaction | VersionedTransaction>(txs: T[]) => {
    for (const tx of txs) {
      if (tx instanceof VersionedTransaction) tx.sign([kp])
      else tx.partialSign(kp)
    }
    return txs
  }
  const raydium = await loadRaydium(connection, kp.publicKey, signAll, 'devnet')
  const configs = await getFeeConfigs(raydium, 'devnet')
  const feeConfig = configs.find((c) => c.tradeFeeRate === 2500) || configs[0]
  console.log(`\n[2] Creating CPMM pool (fee tier ${feeConfig.tradeFeeRate / 10000}%)…`)
  const pool = await createPool(raydium, connection, 'devnet', {
    tokenMint: token.mint,
    tokenAmount: '800000000',
    solAmount: '0.2',
    feeConfig,
  })
  console.log('    pool:', pool.poolId, '\n    tx:', pool.txId)

  const { poolInfo } = await getPool(raydium, pool.poolId)
  const lp = await getLpBalance(connection, kp.publicKey, poolInfo.lpMint.address)
  assert(lp > 0n, `LP tokens in wallet (${lp})`)
  console.log('    reserves:', poolInfo.mintAmountA, poolInfo.mintA.address.slice(0, 6), '/', poolInfo.mintAmountB, poolInfo.mintB.address.slice(0, 6))

  // --- 3. Remove 50% liquidity ---
  console.log('\n[3] Removing 50% liquidity…')
  const before = await connection.getBalance(kp.publicKey)
  const txId = await removeLiquidity(raydium, 'devnet', pool.poolId, lp / 2n)
  console.log('    tx:', txId)
  const lpAfter = await getLpBalance(connection, kp.publicKey, poolInfo.lpMint.address)
  assert(lpAfter === lp - lp / 2n, 'LP balance halved')
  const after = await connection.getBalance(kp.publicKey)
  assert(after > before, `SOL returned (+${(after - before) / LAMPORTS_PER_SOL} SOL)`)

  console.log('\nAll devnet checks passed ✔')
  console.log(`https://solscan.io/token/${token.mint}?cluster=devnet`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
