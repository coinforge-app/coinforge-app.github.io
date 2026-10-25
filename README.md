# CoinForge – Solana Token Toolkit

Eigenes, non-custodial Multitool nach dem Vorbild von mintmemes.io. Alles läuft im Browser; jede Transaktion wird lokal gebaut und von der Wallet signiert (Phantom, Solflare, Backpack … via Wallet Standard).

| Seite | Funktion |
|---|---|
| **🔥 Promoted** (`#/promoted`, Startseite) | Bezahlte Coin-Promotions: Nutzer zahlen `VITE_PROMO_SOL` (Standard 0,05 SOL) an die Gebühren-Wallet und stehen `VITE_PROMO_HOURS` (Standard 24 h) ganz oben. Die Zahlung enthält das Memo `coinforge:promote:<mint>`. Die Startseite liest diese Memos direkt aus der Historie der Gebühren-Wallet und prüft den Betrag, ganz ohne Backend. Es gibt drei Stufen: 🔥 Basic (`VITE_PROMO_SOL`, Standard 0,05 SOL), ⚡ Boost (`VITE_PROMO_BOOST_SOL`, 0,12 SOL, steht über Basic) und 👑 Top Spot (`VITE_PROMO_TOP_SOL`, 0,25 SOL, fest auf Platz 1). Die Stufe ergibt sich aus dem tatsächlich gezahlten Betrag. Erneutes Zahlen verlängert die Laufzeit und addiert die Boost-Punkte. Die Gebühren-Wallet selbst promotet kostenlos (⭐ Featured). Marktdaten kommen von DexScreener, Logo und Name per DAS. Mints in `VITE_PROMO_BLOCKLIST` werden ausgeblendet. Darüber zeigt die Leiste **🆕 Just launched** jeden über CoinForge erstellten Token kostenlos für `VITE_LAUNCH_HOURS` Stunden (Standard 6), mit Button „🔥 Boost“. Erkannt werden die Tokens an der Erstellungsgebühr in der Historie der Gebühren-Wallet. Vorschau lokal: `npm run dev`, dann `/?demo`. |
| **🤝 Earn 30 %** (`#/refer`) | Empfehlungsprogramm: Jeder bekommt einen Link `?ref=<Wallet>`. Wer darüber kommt, bleibt 30 Tage zugeordnet. Bei jeder Token-Gebühr und Promotion gehen `VITE_REF_PERCENT` % (Standard 30) sofort in derselben Transaktion an den Werbenden. Der Kunde zahlt dabei nicht mehr. |
| **📊 Earnings** (`#/earnings`) | Nur sichtbar, wenn die Gebühren-Wallet verbunden ist: Einnahmen (gesamt, 24 h, 7 Tage), verkaufte Tokens und Promotions, Auszahlungen an Werbende, Top-Werbende und die letzten Zahlungen. Alles kommt direkt aus der Blockchain. |
| **Create Coin** (`#/create`) | 3-Schritt-Wizard: Name/Symbol/Logo → Decimals/Supply/Beschreibung → Socials, Creator-Info, Revoke Freeze/Mint/Update. Bild + Metadata-JSON werden über Irys auf Arweave gespeichert; Mint, Metaplex-Metadata, Supply und Revokes laufen in **einer** Transaktion. |
| **Liquidity** (`#/liquidity`) | Raydium-CPMM-Pool (Token/SOL) erstellen inkl. Fee-Tier, Startpreis und Start-Marktkapitalisierung. Optional rechnet ein **Ziel-MC-Rechner** die Token-Menge für eine gewünschte Start-MC aus und zeigt offen an, wie viel Prozent des Supplys beim Ersteller bleiben; eigene Pools listen (lokal gespeichert, „Scan my tokens“ über die Raydium-API oder per Pool-ID hinzufügen); Liquidität teilweise oder ganz entfernen (− Button). |
| **Minted Tokens** (`#/tokens`) | Timeline der erstellten Tokens nach Datum, mit On-Chain-Status (Supply, Mint/Freeze Authority, Pools). „Scan on-chain (DAS)“ findet Tokens per `getAssetsByAuthority`, wenn ein Helius-/DAS-RPC eingestellt ist. |

## Start

```bash
npm install
npm run dev
```

Netzwerk (Devnet/Mainnet) und eigene RPC-URLs stellst du oben rechts ein (Pill + ⚙). Standard-RPCs für alle Besucher setzt du als `VITE_RPC_MAINNET` / `VITE_RPC_DEVNET` (lokal in `.env`, für GitHub Pages als Repository-Variable). Für Mainnet einen eigenen RPC verwenden (Helius, QuickNode …); der öffentliche Endpoint blockt Browser-Anfragen häufig.

## Plattform-Gebühr (optional)

`.env.example` nach `.env` kopieren:

```
VITE_FEE_WALLET=<deine Wallet-Adresse>
VITE_FEE_SOL=0.1          # Grundgebühr pro Token
VITE_FEE_ADDON_SOL=0.1    # pro Add-on (jeder Revoke, Custom Creator)
```

Ohne `VITE_FEE_WALLET` ist das Tool gebührenfrei. Die Gebühr wird als `transferSol` in dieselbe Transaktion gepackt und vor der Bestätigung angezeigt.

## Tests

```bash
npm run simulate   # baut die echten Transaktionen und simuliert sie auf Devnet – kostenlos, nichts wird gesendet
npm run promote-test  # Promotions-Transaktion auf Mainnet simulieren + Listenlogik prüfen (VITE_FEE_WALLET setzen)
npm run e2e        # echter Devnet-Durchlauf (Token → Pool → 50 % Liquidität entfernen) mit Wegwerf-Keypair; braucht ~1 Devnet-SOL
```

`e2e` legt `scripts/.devnet-keypair.json` an. Wenn der Airdrop fehlschlägt, die angezeigte Adresse über https://faucet.solana.com aufladen und erneut starten.

## Produktion

`npm run build` → statische Dateien in `dist/`, deploybar auf Vercel, Netlify, Cloudflare Pages o. ä.

## Stack

Vite + React + TypeScript · `@solana/wallet-adapter` · Metaplex Umi (`mpl-token-metadata`, `mpl-toolbox`, Irys-Uploader) · `@raydium-io/raydium-sdk-v2` (CPMM)
