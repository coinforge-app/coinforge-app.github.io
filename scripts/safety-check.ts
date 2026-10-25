/** Sanity-checks the on-chain safety flags against well-known mainnet tokens. */
import { Connection } from '@solana/web3.js'
import { fetchMintSafety, safetyFlags } from '../src/lib/market'

const connection = new Connection(process.env.MAINNET_RPC || 'https://solana-rpc.publicnode.com', 'confirmed')
const tokens = {
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  PYUSD: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
}
const res = await fetchMintSafety(connection, Object.values(tokens))
for (const [name, mint] of Object.entries(tokens)) {
  console.log(name.padEnd(6), JSON.stringify(res[mint]), '→', safetyFlags({ mint, liquidityUsd: 1e6 }, res[mint]).map((f) => f.text).join(', '))
}
