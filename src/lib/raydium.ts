import {
  CREATE_CPMM_POOL_FEE_ACC,
  CREATE_CPMM_POOL_PROGRAM,
  DEVNET_PROGRAM_ID,
  getCpmmPdaAmmConfigId,
  LOCK_CPMM_AUTH,
  LOCK_CPMM_PROGRAM,
  Percent,
  PoolFetchType,
  Raydium,
  TxVersion,
  type ApiCpmmConfigInfo,
} from '@raydium-io/raydium-sdk-v2'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  PublicKey,
  type Connection,
  type Transaction,
  type TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import type { Network } from './settings'

export const WSOL_MINT = 'So11111111111111111111111111111111111111112'
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

type SignAll = <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>

export function cpmmProgram(network: Network) {
  return network === 'devnet' ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM : CREATE_CPMM_POOL_PROGRAM
}

function computeBudget(network: Network) {
  return network === 'mainnet' ? { units: 600_000, microLamports: 200_000 } : undefined
}

export async function loadRaydium(connection: Connection, owner: PublicKey, signAll: SignAll, network: Network) {
  return Raydium.load({
    connection,
    owner,
    cluster: network === 'devnet' ? 'devnet' : 'mainnet',
    signAllTransactions: signAll,
    disableLoadToken: true,
    blockhashCommitment: 'finalized',
  })
}

export async function getFeeConfigs(raydium: Raydium, network: Network): Promise<ApiCpmmConfigInfo[]> {
  const configs = await raydium.api.getCpmmConfigs()
  if (network === 'devnet') {
    // The API returns mainnet config addresses; devnet configs live at the same index under the devnet program
    for (const c of configs) c.id = getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, c.index).publicKey.toBase58()
  }
  return configs.sort((a, b) => a.tradeFeeRate - b.tradeFeeRate)
}

export async function getMintInfo(connection: Connection, mint: string) {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint))
  const data = info.value?.data
  if (!info.value || !data || !('parsed' in data) || data.parsed.type !== 'mint') throw new Error('Not a valid token mint')
  const parsed = data.parsed.info as {
    decimals: number
    supply: string
    mintAuthority: string | null
    freezeAuthority: string | null
  }
  return { address: mint, programId: info.value.owner.toBase58(), ...parsed }
}

export function toRaw(amount: string, decimals: number) {
  const d = new Decimal(amount || '0')
  if (!d.isFinite() || d.lte(0)) throw new Error('Amounts must be greater than 0')
  return new BN(d.mul(new Decimal(10).pow(decimals)).toFixed(0, Decimal.ROUND_DOWN))
}

export function fromRaw(raw: string | number, decimals: number) {
  return new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toString()
}

export async function createPool(
  raydium: Raydium,
  connection: Connection,
  network: Network,
  p: { tokenMint: string; tokenAmount: string; solAmount: string; feeConfig: ApiCpmmConfigInfo },
) {
  const mint = await getMintInfo(connection, p.tokenMint)
  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId: cpmmProgram(network),
    poolFeeAccount: network === 'devnet' ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC : CREATE_CPMM_POOL_FEE_ACC,
    mintA: { address: mint.address, decimals: mint.decimals, programId: mint.programId },
    mintB: { address: WSOL_MINT, decimals: 9, programId: TOKEN_PROGRAM },
    mintAAmount: toRaw(p.tokenAmount, mint.decimals),
    mintBAmount: toRaw(p.solAmount, 9),
    startTime: new BN(0),
    feeConfig: p.feeConfig,
    associatedOnly: false,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
    computeBudgetConfig: computeBudget(network),
  })
  const { txId } = await execute({ sendAndConfirm: true })
  return {
    txId,
    poolId: extInfo.address.poolId.toBase58(),
    lpMint: extInfo.address.lpMint.toBase58(),
    mintA: extInfo.address.mintA.address,
    mintB: extInfo.address.mintB.address,
  }
}

export async function getPool(raydium: Raydium, poolId: string) {
  return raydium.cpmm.getPoolInfoFromRpc(poolId)
}

export async function getLpBalance(connection: Connection, owner: PublicKey, lpMint: string) {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(lpMint) })
  return res.value.reduce((sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount as string), 0n)
}

export async function removeLiquidity(raydium: Raydium, network: Network, poolId: string, lpAmount: bigint) {
  const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(poolId)
  const { execute } = await raydium.cpmm.withdrawLiquidity({
    poolInfo,
    poolKeys,
    lpAmount: new BN(lpAmount.toString()),
    slippage: new Percent(1, 100),
    txVersion: TxVersion.V0,
    closeWsol: true,
    computeBudgetConfig: computeBudget(network),
  })
  const { txId } = await execute({ sendAndConfirm: true })
  return txId
}

/** CPMM pools for a token paired with SOL, via Raydium's public API. */
export async function findPoolsForMint(raydium: Raydium, network: Network, mint: string) {
  const res = await raydium.api.fetchPoolByMints({ mint1: mint, mint2: WSOL_MINT, type: PoolFetchType.Standard })
  const program = cpmmProgram(network).toBase58()
  return res.data.filter((p) => p.programId === program)
}

const lockIds = (network: Network) =>
  network === 'devnet'
    ? { programId: DEVNET_PROGRAM_ID.LOCK_CPMM_PROGRAM, authProgram: DEVNET_PROGRAM_ID.LOCK_CPMM_AUTH }
    : { programId: LOCK_CPMM_PROGRAM, authProgram: LOCK_CPMM_AUTH }

/**
 * Raydium "Burn & Earn": LP tokens are locked forever; the owner receives a fee-key NFT and keeps
 * claiming trading fees (on raydium.io/portfolio). Extra instructions (platform fee) ride in the same tx.
 */
export async function lockLiquidity(
  raydium: Raydium,
  network: Network,
  poolId: string,
  lpAmount: bigint,
  extraInstructions: TransactionInstruction[] = [],
) {
  const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(poolId)
  const { builder, extInfo } = await raydium.cpmm.lockLp({
    poolInfo,
    poolKeys,
    lpAmount: new BN(lpAmount.toString()),
    withMetadata: true,
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig: computeBudget(network),
    ...lockIds(network),
  })
  if (extraInstructions.length) builder.addInstruction({ instructions: extraInstructions })
  const { execute } = builder.build()
  const { txId } = await execute({ sendAndConfirm: true })
  return { txId, nftMint: extInfo.nftMint.toBase58() }
}

/** Share of a pool's liquidity that is locked (Burn & Earn) or burned — what scanners show as "LP locked". */
export async function liquidityTrust(connection: Connection, network: Network, poolInfo: { lpMint: { address: string }; lpAmount: number }) {
  const lpMint = new PublicKey(poolInfo.lpMint.address)
  // getPoolInfoFromRpc reports lpAmount in raw units
  const poolLp = new Decimal(poolInfo.lpAmount)
  if (poolLp.lte(0)) return { lockedPct: 0, burnedPct: 0 }
  const lockVault = getAssociatedTokenAddressSync(lpMint, lockIds(network).authProgram, true)
  const [supply, locked] = await Promise.all([
    connection.getTokenSupply(lpMint).then((r) => new Decimal(r.value.amount)),
    connection
      .getTokenAccountBalance(lockVault)
      .then((r) => new Decimal(r.value.amount))
      .catch(() => new Decimal(0)),
  ])
  // Burned LP leaves the mint supply but stays counted in the pool's LP total
  const burned = Decimal.max(0, poolLp.minus(supply))
  return { lockedPct: locked.div(poolLp).mul(100).toNumber(), burnedPct: burned.div(poolLp).mul(100).toNumber() }
}
