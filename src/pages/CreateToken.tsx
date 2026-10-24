import { useMemo, useRef, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { countAddons, createToken, DEFAULT_CREATOR, makeUmi, platformFee, rawAmount, type TokenForm } from '../lib/createToken'
import { explorerUrl, FEE_ADDON_SOL, FEE_SOL, useSettings } from '../lib/settings'
import { addToken } from '../lib/storage'
import { CopyButton, errorMessage, Faq, Status, Toggle } from '../lib/ui'

const MAX_IMAGE = 1024 * 1024
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const INITIAL: TokenForm = {
  name: '',
  symbol: '',
  image: null,
  decimals: 9,
  supply: '1000000000',
  description: '',
  website: '',
  twitter: '',
  telegram: '',
  discord: '',
  customCreator: false,
  creatorName: DEFAULT_CREATOR,
  creatorWebsite: '',
  revokeFreeze: true,
  revokeMint: true,
  revokeUpdate: true,
}

const AUTHORITIES = [
  {
    key: 'revokeFreeze',
    title: 'Revoke Freeze',
    text: 'Freeze Authority allows you to freeze token accounts of holders. Required by most DEXs & launch checkers.',
  },
  { key: 'revokeMint', title: 'Revoke Mint', text: 'Mint Authority allows you to mint more supply of your token.' },
  { key: 'revokeUpdate', title: 'Revoke Update', text: 'Update Authority allows you to change the token metadata.' },
] as const

function validUrl(v: string) {
  if (!v.trim()) return true
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol)
  } catch {
    return false
  }
}

export default function CreateToken() {
  const wallet = useWallet()
  const { setVisible } = useWalletModal()
  const { network, rpc } = useSettings()
  const [step, setStep] = useState(1)
  const [form, setForm] = useState<TokenForm>(INITIAL)
  const [preview, setPreview] = useState<string>('')
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ mint: string; signature: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const set = <K extends keyof TokenForm>(k: K, v: TokenForm[K]) => setForm((f) => ({ ...f, [k]: v }))

  const pickImage = (file: File | undefined) => {
    if (!file) return
    if (!IMAGE_TYPES.includes(file.type)) return setError('Only PNG, JPG, WEBP and GIF images are allowed.')
    if (file.size > MAX_IMAGE) return setError('Image must be 1 MB or smaller.')
    setError('')
    set('image', file)
    setPreview(URL.createObjectURL(file))
  }

  const stepError = useMemo(() => {
    if (step === 1) {
      if (!form.name.trim()) return 'Enter a token name'
      if (!form.symbol.trim()) return 'Enter a token symbol'
      if (!form.image) return 'Upload a token image'
    }
    if (step === 2) {
      if (!Number.isInteger(form.decimals) || form.decimals < 0 || form.decimals > 9) return 'Decimals must be 0–9'
      try {
        rawAmount(form.supply, form.decimals)
      } catch (e) {
        return (e as Error).message
      }
    }
    if (step === 3) {
      for (const k of ['website', 'twitter', 'telegram', 'discord'] as const)
        if (!validUrl(form[k])) return `Invalid ${k} URL`
      if (form.customCreator && !validUrl(form.creatorWebsite)) return 'Invalid creator website URL'
    }
    return ''
  }, [step, form])

  const fee = platformFee(form)
  const addons = countAddons(form)

  const submit = async () => {
    if (!wallet.publicKey) return setVisible(true)
    setBusy(true)
    setError('')
    try {
      const umi = makeUmi(rpc, network, wallet)
      const res = await createToken(umi, network, form, setProgress)
      addToken({
        mint: res.mint,
        name: form.name,
        symbol: form.symbol,
        image: res.imageUri,
        uri: res.uri,
        decimals: form.decimals,
        supply: form.supply,
        creator: wallet.publicKey.toBase58(),
        network,
        signature: res.signature,
        createdAt: Date.now(),
      })
      setResult({ mint: res.mint, signature: res.signature })
    } catch (e) {
      console.error(e)
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const reset = () => {
    setForm(INITIAL)
    setPreview('')
    setResult(null)
    setStep(1)
  }

  return (
    <>
      <section className="hero">
        <h1>
          Create Meme Coins Effortlessly <span className="accent">⚡</span>
        </h1>
        <p>Launch an SPL token with Metaplex metadata in three steps. No code, full ownership, signed in your wallet.</p>
      </section>

      {result ? (
        <div className="card success-card">
          <div className="success-icon">🎉</div>
          <h2>
            {form.name} (${form.symbol}) is live on {network === 'mainnet' ? 'Mainnet' : 'Devnet'}
          </h2>
          {preview && <img className="token-img lg" src={preview} alt="" />}
          <div className="kv">
            <span>Mint address</span>
            <code>
              {result.mint} <CopyButton text={result.mint} />
            </code>
          </div>
          <div className="row center wrap">
            <a className="btn ghost" href={explorerUrl('token', result.mint, network)} target="_blank" rel="noreferrer">
              View on Solscan ↗
            </a>
            <a className="btn ghost" href={explorerUrl('tx', result.signature, network)} target="_blank" rel="noreferrer">
              Transaction ↗
            </a>
            <a className="btn primary" href={`#/liquidity?mint=${result.mint}`}>
              Create Liquidity Pool 💧
            </a>
          </div>
          <button className="link-btn" onClick={reset}>
            Create another token
          </button>
        </div>
      ) : (
        <div className="card wizard">
          <div className="stepper">
            {[1, 2, 3].map((s) => (
              <div key={s} className="stepper-item">
                <span className={s < step ? 'dot done' : s === step ? 'dot active' : 'dot'}>{s < step ? '✓' : s}</span>
                {s < 3 && <i className={s < step ? 'bar done' : 'bar'} />}
              </div>
            ))}
          </div>

          {step === 1 && (
            <>
              <div className="grid2">
                <label className="field">
                  <span>Token Name</span>
                  <input
                    id="token-name"
                    maxLength={32}
                    placeholder="Meme Coin"
                    value={form.name}
                    onChange={(e) => set('name', e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Token Symbol</span>
                  <input
                    id="token-symbol"
                    maxLength={10}
                    placeholder="MEME"
                    value={form.symbol}
                    onChange={(e) => set('symbol', e.target.value.toUpperCase())}
                  />
                </label>
              </div>
              <div className="field">
                <span>Token Image</span>
                <div
                  className={dragOver ? 'dropzone over' : 'dropzone'}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOver(true)
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOver(false)
                    pickImage(e.dataTransfer.files[0])
                  }}
                >
                  {preview ? (
                    <img src={preview} alt="Token logo preview" className="token-img lg" />
                  ) : (
                    <div className="drop-icon">⬆</div>
                  )}
                  <strong>{form.image ? form.image.name : 'Drag & Drop your logo here'}</strong>
                  <small>Or click to browse (max 1 MB · PNG, JPG, WEBP, GIF · square 512×512 recommended)</small>
                  <input
                    ref={fileRef}
                    type="file"
                    hidden
                    accept={IMAGE_TYPES.join(',')}
                    onChange={(e) => pickImage(e.target.files?.[0])}
                  />
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid2">
                <label className="field">
                  <span>Token Decimals</span>
                  <input
                    id="token-decimals"
                    type="number"
                    min={0}
                    max={9}
                    value={form.decimals}
                    onChange={(e) => set('decimals', Number(e.target.value))}
                  />
                  <small>9 for meme coins · 6 for utility tokens · 0 for whitelist tokens</small>
                </label>
                <label className="field">
                  <span>Token Supply</span>
                  <input
                    id="token-supply"
                    inputMode="numeric"
                    value={form.supply}
                    onChange={(e) => set('supply', e.target.value.replace(/[^\d]/g, ''))}
                  />
                  <small>{form.supply ? Number(form.supply).toLocaleString('en-US') : '—'} tokens</small>
                </label>
              </div>
              <label className="field">
                <span>Token Description</span>
                <textarea
                  id="token-description"
                  maxLength={300}
                  rows={4}
                  placeholder="Describe your token (optional)"
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                />
                <small className="right">{form.description.length}/300</small>
              </label>
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid2">
                {(
                  [
                    ['website', 'Website', 'https://example.com'],
                    ['discord', 'Discord', 'https://discord.gg/invite'],
                    ['telegram', 'Telegram', 'https://t.me/username'],
                    ['twitter', 'X', 'https://x.com/username'],
                  ] as const
                ).map(([k, label, ph]) => (
                  <label className="field" key={k}>
                    <span>{label}</span>
                    <input type="url" placeholder={ph} value={form[k]} onChange={(e) => set(k, e.target.value)} />
                  </label>
                ))}
              </div>

              <div className="option-row">
                <div>
                  <strong>Modify Creator Information</strong>
                  <p>Change the creator shown in the metadata. By default it is {DEFAULT_CREATOR}.</p>
                </div>
                <Toggle checked={form.customCreator} onChange={(v) => set('customCreator', v)} />
              </div>
              {form.customCreator && (
                <div className="grid2">
                  <label className="field">
                    <span>Creator Name</span>
                    <input value={form.creatorName} onChange={(e) => set('creatorName', e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Creator Website</span>
                    <input
                      type="url"
                      placeholder="https://example.com"
                      value={form.creatorWebsite}
                      onChange={(e) => set('creatorWebsite', e.target.value)}
                    />
                  </label>
                </div>
              )}

              <h4 className="section-title">Authority Options</h4>
              <div className="grid3">
                {AUTHORITIES.map((a) => (
                  <button
                    key={a.key}
                    className={form[a.key] ? 'auth-card selected' : 'auth-card'}
                    onClick={() => set(a.key, !form[a.key])}
                  >
                    <div className="auth-head">
                      <strong>{a.title}</strong>
                      <span className="check">{form[a.key] ? '✓' : ''}</span>
                    </div>
                    <p>{a.text}</p>
                    <small>{form[a.key] ? 'Selected' : 'Not selected'}{FEE_ADDON_SOL > 0 ? ` · +${FEE_ADDON_SOL} SOL` : ''}</small>
                  </button>
                ))}
              </div>

              <div className="summary">
                <div>
                  <span>Platform fee</span>
                  <strong>
                    {fee > 0 ? `${fee.toFixed(2)} SOL` : 'Free'}
                    {FEE_SOL > 0 && addons > 0 && <small> ({addons} add-on{addons > 1 ? 's' : ''})</small>}
                  </strong>
                </div>
                <div>
                  <span>Rent + storage (est.)</span>
                  <strong>≈ 0.01–0.02 SOL</strong>
                </div>
                <div>
                  <span>Network</span>
                  <strong className={network === 'mainnet' ? 'warn-text' : ''}>
                    {network === 'mainnet' ? 'Mainnet (real SOL)' : 'Devnet (test SOL)'}
                  </strong>
                </div>
              </div>
            </>
          )}

          {error && <Status kind="error">{error}</Status>}
          {busy && <Status kind="info">⏳ {progress || 'Working…'}</Status>}

          <div className="row between">
            {step > 1 ? (
              <button className="btn ghost" disabled={busy} onClick={() => setStep(step - 1)}>
                Previous
              </button>
            ) : (
              <span />
            )}
            {step < 3 ? (
              <button
                className="btn primary"
                disabled={!!stepError}
                title={stepError}
                onClick={() => {
                  setError('')
                  setStep(step + 1)
                }}
              >
                Next
              </button>
            ) : (
              <button className="btn primary" disabled={!!stepError || busy} onClick={submit}>
                {wallet.publicKey ? (busy ? 'Creating…' : 'Create Token') : 'Connect Wallet'}
              </button>
            )}
          </div>
          {stepError && !busy && <p className="hint center">{stepError}</p>}
        </div>
      )}

      <section className="info card">
        <h2>How to use the Meme Coin Creator</h2>
        <ol>
          <li>Connect your wallet (Phantom, Solflare, Backpack…).</li>
          <li>Enter the token name (up to 32 characters) and symbol (up to 10 characters).</li>
          <li>Upload the token image (PNG / JPG / WEBP / GIF, max 1 MB).</li>
          <li>Select decimals (9 for meme coins, 6 for utility tokens, 0 for whitelist tokens) and the supply.</li>
          <li>Add a description and social links — they are stored in the token metadata.</li>
          <li>Choose which authorities to revoke, click Create, and approve in your wallet.</li>
        </ol>
      </section>

      <section className="info">
        <h2>Frequently Asked Questions</h2>
        <Faq
          items={[
            {
              q: 'What is CoinForge?',
              a: 'A self-hosted, non-custodial interface that creates SPL tokens with Metaplex metadata and manages Raydium CPMM liquidity pools. Nothing runs on a server — every transaction is built in your browser and signed by your wallet.',
            },
            {
              q: 'Where are the image and metadata stored?',
              a: 'On Arweave via Irys. Small files are free; larger ones cost a few lamports, paid from your wallet. On devnet, Irys uploads are temporary.',
            },
            {
              q: 'Why revoke authorities?',
              a: 'Revoking mint authority fixes the supply forever, revoking freeze authority prevents holders’ tokens from being frozen, and revoking update authority makes the metadata immutable. Most traders and token checkers expect at least mint + freeze to be revoked. Revoking is irreversible.',
            },
            {
              q: 'Are there any fees?',
              a:
                fee > 0 || FEE_SOL > 0
                  ? `This instance charges ${FEE_SOL} SOL per token${FEE_ADDON_SOL > 0 ? ` plus ${FEE_ADDON_SOL} SOL per add-on` : ''}, shown before approval. Network rent (~0.01–0.02 SOL) and Raydium pool fees apply separately.`
                  : 'This instance charges no platform fee. You only pay Solana rent (~0.01–0.02 SOL) and, when creating a pool, Raydium’s pool creation fee.',
            },
            {
              q: 'How does liquidity work?',
              a: 'On the Manage Liquidity page you create a Raydium CPMM pool (Token / SOL). The LP tokens stay in your wallet, so you can remove liquidity any time — or burn the LP tokens yourself to lock it permanently.',
            },
          ]}
        />
      </section>
    </>
  )
}
