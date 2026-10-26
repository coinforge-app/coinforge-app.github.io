import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { ConnectionProvider, useWallet, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { isOwner } from './lib/promote'
import { DEFAULT_RPC, FEE_ADDON_SOL, FEE_SOL, PROMO_SOL, REF_PERCENT, SettingsProvider, useSettings, type Network } from './lib/settings'

// Pages pull in heavy SDKs (Metaplex/Irys, Raydium) — load each on demand
const Promoted = lazy(() => import('./pages/Promoted'))
const Trending = lazy(() => import('./pages/Trending'))
const CreateToken = lazy(() => import('./pages/CreateToken'))
const Liquidity = lazy(() => import('./pages/Liquidity'))
const Tokens = lazy(() => import('./pages/Tokens'))
const Airdrop = lazy(() => import('./pages/Airdrop'))
const Refer = lazy(() => import('./pages/Refer'))
const Earnings = lazy(() => import('./pages/Earnings'))

const ROUTES = {
  promoted: { label: '🔥 Promoted', page: Promoted },
  trending: { label: '📈 Trending', page: Trending },
  create: { label: 'Create', page: CreateToken },
  liquidity: { label: 'Liquidity', page: Liquidity },
  tokens: { label: 'My Tokens', page: Tokens },
  airdrop: { label: '🪂 Airdrop', page: Airdrop },
  refer: { label: `🤝 Earn ${REF_PERCENT}%`, page: Refer },
  earnings: { label: '📊 Earnings', page: Earnings },
} as const
// Only shown in the nav to the fee wallet owner
const OWNER_ONLY: Route[] = ['earnings']
type Route = keyof typeof ROUTES

function useRoute(): Route {
  const read = () => {
    const r = window.location.hash.replace(/^#\/?/, '').split('?')[0] as Route
    return r in ROUTES ? r : 'promoted'
  }
  const [route, setRoute] = useState<Route>(read)
  useEffect(() => {
    const onHash = () => {
      setRoute(read())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  return route
}

function SolanaProviders({ children }: { children: ReactNode }) {
  const { rpc } = useSettings()
  return (
    <ConnectionProvider endpoint={rpc} key={rpc}>
      {/* Empty list: Phantom, Solflare, Backpack etc. register via Wallet Standard */}
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { network, setNetwork, customRpc, setCustomRpc } = useSettings()
  const [draft, setDraft] = useState(customRpc)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <h3>Settings</h3>
        <label className="field">
          <span>Network</span>
          <div className="segmented">
            {(['devnet', 'mainnet'] as Network[]).map((n) => (
              <button key={n} className={n === network ? 'active' : ''} onClick={() => setNetwork(n)}>
                {n === 'mainnet' ? 'Mainnet' : 'Devnet'}
              </button>
            ))}
          </div>
        </label>
        {(['mainnet', 'devnet'] as Network[]).map((n) => (
          <label className="field" key={n}>
            <span>{n === 'mainnet' ? 'Mainnet' : 'Devnet'} RPC URL</span>
            <input
              value={draft[n]}
              placeholder={DEFAULT_RPC[n]}
              onChange={(e) => setDraft({ ...draft, [n]: e.target.value })}
            />
          </label>
        ))}
        <p className="hint">
          The public mainnet RPC rate-limits browsers heavily. For mainnet, use your own endpoint (Helius, QuickNode,
          Triton…). A Helius/DAS-capable RPC also enables on-chain token discovery.
        </p>
        <div className="row end">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              setCustomRpc('mainnet', draft.mainnet)
              setCustomRpc('devnet', draft.devnet)
              onClose()
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function Shell() {
  const route = useRoute()
  const { publicKey } = useWallet()
  const owner = isOwner(publicKey)
  const { network, setNetwork } = useSettings()
  const [menuOpen, setMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const Page = ROUTES[route].page

  const feeText =
    FEE_SOL > 0
      ? `Create tokens from ${FEE_SOL} SOL${FEE_ADDON_SOL > 0 ? ` • Add-ons ${FEE_ADDON_SOL} SOL each` : ''}`
      : 'No platform fees — you only pay Solana network & storage costs'

  return (
    <>
      <div className="announce">
        🚀 {feeText} • 🔥 Promote your coin from {PROMO_SOL} SOL • 🤝 Refer traders &amp; earn {REF_PERCENT}%
      </div>
      <header className="header">
        <div className="header-inner">
          <button className="menu-btn" aria-label="Toggle menu" onClick={() => setMenuOpen(!menuOpen)}>
            ☰
          </button>
          <a href="#/promoted" className="logo">
            <span className="logo-mark">◆</span>
            <b>
              Coin<span>Forge</span>
            </b>
          </a>
          <nav className={menuOpen ? 'nav open' : 'nav'} onClick={() => setMenuOpen(false)}>
            {(Object.keys(ROUTES) as Route[])
              .filter((r) => owner || !OWNER_ONLY.includes(r))
              .map((r) => (
              <a key={r} href={`#/${r}`} className={r === route ? 'active' : ''}>
                {ROUTES[r].label}
              </a>
            ))}
          </nav>
          <div className="header-actions">
            <button
              className={`net-pill ${network}`}
              title="Switch network"
              onClick={() => setNetwork(network === 'devnet' ? 'mainnet' : 'devnet')}
            >
              <i /> {network === 'mainnet' ? 'Mainnet' : 'Devnet'}
            </button>
            <button className="icon-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
              ⚙
            </button>
            <WalletMultiButton />
          </div>
        </div>
      </header>
      <main className="container">
        <Suspense fallback={<div className="card empty page-loading">Loading…</div>}>
          <Page />
        </Suspense>
      </main>
      <footer className="footer">
        <p>
          CoinForge is a non-custodial interface to public Solana programs (SPL Token, Metaplex Token Metadata, Raydium
          CPMM). Every transaction is built in your browser and signed by your wallet. Use at your own risk.
        </p>
        <p>© {new Date().getFullYear()} CoinForge</p>
      </footer>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </>
  )
}

export default function App() {
  return (
    <SettingsProvider>
      <SolanaProviders>
        <Shell />
      </SolanaProviders>
    </SettingsProvider>
  )
}
