import type { Network } from './settings'

// Local history of what this browser created. The chain is the source of truth;
// this just lets us list tokens/pools without an indexer.

export interface TokenRecord {
  mint: string
  name: string
  symbol: string
  image: string
  uri: string
  decimals: number
  supply: string
  creator: string
  network: Network
  signature: string
  createdAt: number
}

export interface PoolRecord {
  poolId: string
  mintA: string
  mintB: string
  lpMint: string
  creator: string
  network: Network
  signature?: string
  createdAt: number
}

function read<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]') as T[]
  } catch {
    return []
  }
}

function write<T>(key: string, items: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify(items))
  } catch {
    /* storage unavailable */
  }
}

export function getTokens(owner: string, network: Network) {
  return read<TokenRecord>('cf.tokens')
    .filter((t) => t.creator === owner && t.network === network)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function addToken(t: TokenRecord) {
  write('cf.tokens', [t, ...read<TokenRecord>('cf.tokens').filter((x) => x.mint !== t.mint)])
}

export function getPools(owner: string, network: Network) {
  return read<PoolRecord>('cf.pools')
    .filter((p) => p.creator === owner && p.network === network)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export function addPool(p: PoolRecord) {
  write('cf.pools', [p, ...read<PoolRecord>('cf.pools').filter((x) => x.poolId !== p.poolId)])
}

export function removePool(poolId: string) {
  write('cf.pools', read<PoolRecord>('cf.pools').filter((x) => x.poolId !== poolId))
}
