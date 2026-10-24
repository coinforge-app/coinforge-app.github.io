import { createContext, useContext, useState, type ReactNode } from 'react'

export type Network = 'devnet' | 'mainnet'

// Build-time RPCs (e.g. Helius) apply to every visitor; users can still override them in Settings
export const DEFAULT_RPC: Record<Network, string> = {
  devnet: (import.meta.env?.VITE_RPC_DEVNET as string | undefined)?.trim() || 'https://api.devnet.solana.com',
  mainnet: (import.meta.env?.VITE_RPC_MAINNET as string | undefined)?.trim() || 'https://api.mainnet-beta.solana.com',
}

export const FEE_WALLET = (import.meta.env?.VITE_FEE_WALLET as string | undefined)?.trim() || ''
export const FEE_SOL = FEE_WALLET ? Number(import.meta.env?.VITE_FEE_SOL ?? 0) || 0 : 0
export const FEE_ADDON_SOL = FEE_WALLET ? Number(import.meta.env?.VITE_FEE_ADDON_SOL ?? 0) || 0 : 0

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
