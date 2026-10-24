import { useEffect, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import type { Raydium } from '@raydium-io/raydium-sdk-v2'
import { loadRaydium } from './raydium'
import { useSettings } from './settings'
import { errorMessage } from './ui'

export function useRaydium() {
  const { connection } = useConnection()
  const { publicKey, signAllTransactions } = useWallet()
  const { network } = useSettings()
  const [raydium, setRaydium] = useState<Raydium | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setRaydium(null)
    setError('')
    if (!publicKey || !signAllTransactions) return
    let cancelled = false
    loadRaydium(connection, publicKey, signAllTransactions, network)
      .then((r) => !cancelled && setRaydium(r))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [connection, publicKey, signAllTransactions, network])

  return { raydium, error }
}
