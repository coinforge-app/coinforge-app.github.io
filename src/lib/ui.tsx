import { useState, type ReactNode } from 'react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'

export function short(addr: string, n = 4) {
  return addr.length > n * 2 + 3 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr
}

export function errorMessage(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  if (/User rejected|rejected the request/i.test(msg)) return 'Transaction was rejected in the wallet.'
  if (/insufficient (funds|lamports)|0x1\b/i.test(msg)) return 'Insufficient SOL balance for this transaction.'
  if (/403|429|Too many requests/i.test(msg)) return 'RPC refused or rate-limited the request. Set your own RPC URL in Settings (⚙).'
  return msg
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="copy-btn"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {done ? '✓' : '⧉'}
    </button>
  )
}

export function Toggle({ checked, onChange, id }: { checked: boolean; onChange: (v: boolean) => void; id?: string }) {
  return (
    <button
      id={id}
      role="switch"
      aria-checked={checked}
      className={checked ? 'toggle on' : 'toggle'}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function ConnectGate({ text }: { text: string }) {
  const { setVisible } = useWalletModal()
  return (
    <div className="card gate">
      <div className="gate-icon">👛</div>
      <p>{text}</p>
      <button className="btn primary" onClick={() => setVisible(true)}>
        Connect Wallet
      </button>
    </div>
  )
}

export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="faq">
      {items.map((it, i) => (
        <div key={i} className={open === i ? 'faq-item open' : 'faq-item'}>
          <button onClick={() => setOpen(open === i ? null : i)}>
            {it.q}
            <span>{open === i ? '−' : '+'}</span>
          </button>
          {open === i && <div className="faq-body">{it.a}</div>}
        </div>
      ))}
    </div>
  )
}

export function Status({ kind, children }: { kind: 'info' | 'error' | 'success'; children: ReactNode }) {
  return <div className={`status ${kind}`}>{children}</div>
}
