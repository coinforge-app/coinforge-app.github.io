import {
  createGenericFileFromBrowserFile,
  generateSigner,
  percentAmount,
  publicKey,
  sol,
  transactionBuilder,
  type Signer,
  type Umi,
} from '@metaplex-foundation/umi'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults'
import { walletAdapterIdentity, type WalletAdapter } from '@metaplex-foundation/umi-signer-wallet-adapters'
import { irysUploader } from '@metaplex-foundation/umi-uploader-irys/web'
import { createAndMint, mplTokenMetadata, TokenStandard } from '@metaplex-foundation/mpl-token-metadata'
import {
  AuthorityType,
  mplToolbox,
  setAuthority,
  setComputeUnitPrice,
  transferSol,
} from '@metaplex-foundation/mpl-toolbox'
import { base58 } from '@metaplex-foundation/umi/serializers'
import { FEE_ADDON_SOL, FEE_SOL, FEE_WALLET, type Network } from './settings'

export interface TokenForm {
  name: string
  symbol: string
  image: File | null
  decimals: number
  supply: string
  description: string
  website: string
  twitter: string
  telegram: string
  discord: string
  customCreator: boolean
  creatorName: string
  creatorWebsite: string
  revokeFreeze: boolean
  revokeMint: boolean
  revokeUpdate: boolean
}

export const DEFAULT_CREATOR = 'CoinForge'

const IRYS_NODE: Record<Network, string> = {
  devnet: 'https://devnet.irys.xyz',
  mainnet: 'https://uploader.irys.xyz',
}

export function makeUmi(rpc: string, network: Network, wallet: WalletAdapter): Umi {
  return createUmi(rpc)
    .use(mplTokenMetadata())
    .use(mplToolbox())
    .use(walletAdapterIdentity(wallet))
    .use(irysUploader({ address: IRYS_NODE[network], providerUrl: rpc }))
}

export function countAddons(f: Pick<TokenForm, 'customCreator' | 'revokeFreeze' | 'revokeMint' | 'revokeUpdate'>) {
  return [f.customCreator, f.revokeFreeze, f.revokeMint, f.revokeUpdate].filter(Boolean).length
}

export function platformFee(f: Parameters<typeof countAddons>[0]) {
  return FEE_SOL + countAddons(f) * FEE_ADDON_SOL
}

/** Raw base-unit amount (supply * 10^decimals) as a u64-safe bigint. */
export function rawAmount(supply: string, decimals: number): bigint {
  if (!/^\d+$/.test(supply)) throw new Error('Supply must be a whole number')
  const amount = BigInt(supply) * 10n ** BigInt(decimals)
  if (amount <= 0n) throw new Error('Supply must be greater than 0')
  if (amount > 2n ** 64n - 1n) throw new Error('Supply × 10^decimals exceeds the u64 limit — lower supply or decimals')
  return amount
}

export type Progress = (step: string) => void

export async function createToken(umi: Umi, network: Network, form: TokenForm, onProgress: Progress) {
  if (!form.image) throw new Error('Token image is required')
  rawAmount(form.supply, form.decimals) // validate before uploading anything

  onProgress('Uploading image to Arweave (Irys)…')
  const [imageUri] = await umi.uploader.upload([await createGenericFileFromBrowserFile(form.image)])

  const extensions = Object.fromEntries(
    (['website', 'twitter', 'telegram', 'discord'] as const)
      .filter((k) => form[k].trim())
      .map((k) => [k, form[k].trim()]),
  )
  const creatorName = form.customCreator ? form.creatorName.trim() || DEFAULT_CREATOR : DEFAULT_CREATOR
  const creatorSite = form.customCreator ? form.creatorWebsite.trim() : ''

  onProgress('Uploading metadata…')
  const uri = await umi.uploader.uploadJson({
    name: form.name,
    symbol: form.symbol,
    description: form.description,
    image: imageUri,
    ...extensions,
    extensions,
    tags: [],
    creator: { name: creatorName, site: creatorSite },
    properties: { files: [{ uri: imageUri, type: form.image.type }], category: 'image' },
  })

  const mint = generateSigner(umi)
  const builder = buildCreateTokenTx(umi, network, form, mint, uri)

  onProgress('Waiting for wallet approval…')
  const signatures: string[] = []
  // Split only if the combined instructions exceed the transaction size limit
  for (const tx of builder.unsafeSplitByTransactionSize(umi)) {
    const res = await tx.sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } })
    signatures.push(base58.deserialize(res.signature)[0])
    onProgress('Confirming on-chain…')
  }

  return { mint: mint.publicKey.toString(), uri, imageUri, signature: signatures[signatures.length - 1] }
}

/** Fee transfer + create mint/metadata + mint supply + optional authority revokes. */
export function buildCreateTokenTx(umi: Umi, network: Network, form: TokenForm, mint: Signer, uri: string) {
  const amount = rawAmount(form.supply, form.decimals)
  let builder = transactionBuilder()
  if (network === 'mainnet') builder = builder.add(setComputeUnitPrice(umi, { microLamports: 200_000 }))

  const fee = platformFee(form)
  if (fee > 0 && FEE_WALLET) {
    builder = builder.add(transferSol(umi, { destination: publicKey(FEE_WALLET), amount: sol(fee) }))
  }

  builder = builder.add(
    createAndMint(umi, {
      mint,
      authority: umi.identity,
      name: form.name,
      symbol: form.symbol,
      uri,
      sellerFeeBasisPoints: percentAmount(0),
      decimals: form.decimals,
      amount,
      tokenOwner: umi.identity.publicKey,
      tokenStandard: TokenStandard.Fungible,
      isMutable: !form.revokeUpdate,
    }),
  )

  // Token Metadata sets both mint & freeze authority to the creator; revoke after minting
  if (form.revokeMint) {
    builder = builder.add(
      setAuthority(umi, { owned: mint.publicKey, owner: umi.identity, authorityType: AuthorityType.MintTokens, newAuthority: null }),
    )
  }
  if (form.revokeFreeze) {
    builder = builder.add(
      setAuthority(umi, { owned: mint.publicKey, owner: umi.identity, authorityType: AuthorityType.FreezeAccount, newAuthority: null }),
    )
  }

  return builder
}
