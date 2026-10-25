import { createContext, useContext, useState, type ReactNode } from 'react'

export type Network = 'devnet' | 'mainnet'

// Build-time RPCs (e.g. Helius) apply to every visitor; users can still override them in Settings
export const DEFAULT_RPC: Record<Network, string> = {
  devnet: (import.meta.env?.VITE_RPC_DEVNET as string | undefined)?.trim() || 'https://api.devnet.solana.com',
  mainnet: (import.meta.env?.VITE_RPC_MAINNET as string | undefined)?.trim() || 'https://api.mainnet-beta.solana.com',
}

// Vite injects import.meta.env; Node scripts (scripts/*.ts) fall back to process.env
const env: Record<string, string | undefined> =
  import.meta.env ?? (globalThis as { process?: { env: Record<string, string> } }).process?.env ?? {}

export const FEE_WALLET = env.VITE_FEE_WALLET?.trim() || ''
export const FEE_SOL = FEE_WALLET ? Number(env.VITE_FEE_SOL ?? 0) || 0 : 0
export const FEE_ADDON_SOL = FEE_WALLET ? Number(env.VITE_FEE_ADDON_SOL ?? 0) || 0 : 0

// Paid homepage promotions (payments go to FEE_WALLET; the fee wallet itself promotes for free)
export const PROMO_SOL = Number(env.VITE_PROMO_SOL || 0.05)
export const PROMO_HOURS = Number(env.VITE_PROMO_HOURS || 24)
export const PROMO_BLOCKLIST = new Set((env.VITE_PROMO_BLOCKLIST || '').split(',').map((s) => s.trim()).filter(Boolean))

interface Settings {
  network: Network
  rpc: string
  setNetwork: (n: Network) => void
  setCustomRpc: (n: Network, url: string) => void
  customRpc: Record<Network, string>
}

const SettingsContext = createContext<Settings | null>(null)

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable */
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [network, setNetworkState] = useState<Network>(() => load('cf.network', 'mainnet'))
  const [customRpc, setCustomRpcState] = useState<Record<Network, string>>(() =>
    load('cf.rpc', { devnet: '', mainnet: '' }),
  )

  const setNetwork = (n: Network) => {
    setNetworkState(n)
    save('cf.network', n)
  }
  const setCustomRpc = (n: Network, url: string) => {
    const next = { ...customRpc, [n]: url.trim() }
    setCustomRpcState(next)
    save('cf.rpc', next)
  }

  const rpc = customRpc[network] || DEFAULT_RPC[network]

  return (
    <SettingsContext.Provider value={{ network, rpc, setNetwork, setCustomRpc, customRpc }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings outside SettingsProvider')
  return ctx
}

export function explorerUrl(kind: 'token' | 'tx' | 'account', id: string, network: Network) {
  const base = `https://solscan.io/${kind}/${id}`
  return network === 'devnet' ? `${base}?cluster=devnet` : base
}
