import { useWallet } from '@solana/wallet-adapter-react'
import { isOwner } from '../lib/promote'
import { referralLink } from '../lib/referral'
import { FEE_ADDON_SOL, FEE_SOL, FEE_WALLET, PROMO_SOL, REF_PERCENT } from '../lib/settings'
import { ConnectGate, CopyButton, Faq, Status } from '../lib/ui'

const fmt = (sol: number) => `${Number((sol * REF_PERCENT) / 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} SOL`

export default function Refer() {
  const { publicKey } = useWallet()
  const link = publicKey ? referralLink(publicKey) : ''
  const shareText = `Launch your own Solana memecoin in ~60 seconds — no code, non-custodial 🚀`
  const fullToken = FEE_SOL + 3 * FEE_ADDON_SOL

  return (
    <>
      <section className="hero">
        <h1>
          Refer traders, earn <span className="accent">{REF_PERCENT}%</span> 🤝
        </h1>
        <p>
          Launch promo: {REF_PERCENT}% of every fee paid through your link goes straight to your wallet — instantly,
          on-chain, no sign-up, no withdrawal.
        </p>
      </section>

      {!FEE_WALLET || !REF_PERCENT ? (
        <Status kind="info">The referral program is not active on this instance.</Status>
      ) : !publicKey ? (
        <ConnectGate text="Connect your wallet to get your personal referral link." />
      ) : isOwner(publicKey) ? (
        <Status kind="info">You are the platform owner — you already receive 100% of all fees. See 📊 Earnings.</Status>
      ) : (
        <div className="card ref-card">
          <h3>Your referral link</h3>
          <div className="ref-link">
            <code>{link}</code>
            <CopyButton text={link} />
          </div>
          <div className="row wrap">
            <a
              className="btn primary sm"
              target="_blank"
              rel="noreferrer"
              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(link)}`}
            >
              Share on X
            </a>
            <a
              className="btn ghost sm"
              target="_blank"
              rel="noreferrer"
              href={`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`}
            >
              Share on Telegram
            </a>
          </div>
          <p className="hint">Payouts go to the wallet in your link: {publicKey.toBase58()}</p>
        </div>
      )}

      <section className="info card">
        <h2>What you earn</h2>
        <div className="summary ref-earn">
          <div>
            <span>Someone launches a token (all 3 revokes)</span>
            <strong>{fmt(fullToken)}</strong>
          </div>
          <div>
            <span>Someone launches a basic token</span>
            <strong>{fmt(FEE_SOL)}</strong>
          </div>
          <div>
            <span>Someone promotes a coin (24h)</span>
            <strong>{fmt(PROMO_SOL)}</strong>
          </div>
        </div>
        <ol>
          <li>Copy your link and share it — Telegram groups, X, TikTok, Discord.</li>
          <li>Anyone who opens CoinForge through it is linked to you for 30 days (same browser).</li>
          <li>Every time they launch or promote a coin, {REF_PERCENT}% of the fee is sent to your wallet in the same transaction.</li>
        </ol>
        <p className="hint">The people you refer pay exactly the same price — the fee is simply split.</p>
      </section>

      <section className="info">
        <h2>Referral FAQ</h2>
        <Faq
          items={[
            { q: 'When do I get paid?', a: 'Instantly. Your share is a separate transfer inside the customer’s own transaction — the moment it confirms, the SOL is in your wallet.' },
            { q: 'How long does a referral last?', a: 'The first referral link someone opens is remembered for 30 days in their browser. If they switch devices or clear their browser data, the link is lost.' },
            { q: 'Can I refer myself?', a: 'No — when the paying wallet is the same as the referrer, no referral share is paid.' },
            { q: 'Is there a minimum or a cap?', a: 'No minimum payout and no cap. Every qualifying fee pays out on its own.' },
          ]}
        />
      </section>
    </>
  )
}
