# CoinForge – Solana Token Toolkit

Eigenes, non-custodial Multitool nach dem Vorbild von mintmemes.io. Alles läuft im Browser; jede Transaktion wird lokal gebaut und von der Wallet signiert (Phantom, Solflare, Backpack … via Wallet Standard).

| Seite | Funktion |
|---|---|
| **Create Coin** (`#/create`) | 3-Schritt-Wizard: Name/Symbol/Logo → Decimals/Supply/Beschreibung → Socials, Creator-Info, Revoke Freeze/Mint/Update. Bild + Metadata-JSON werden über Irys auf Arweave gespeichert; Mint, Metaplex-Metadata, Supply und Revokes laufen in **einer** Transaktion. |
| **Manage Liquidity** (`#/liquidity`) | Raydium-CPMM-Pool (Token/SOL) erstellen inkl. Fee-Tier, Startpreis und FDV-Vorschau; eigene Pools listen (lokal gespeichert, „Scan my tokens“ über die Raydium-API oder per Pool-ID hinzufügen); Liquidität teilweise oder ganz entfernen (− Button). |
| **Minted Tokens** (`#/tokens`) | Timeline der erstellten Tokens nach Datum, mit On-Chain-Status (Supply, Mint/Freeze Authority, Pools). „Scan on-chain (DAS)“ findet Tokens per `getAssetsByAuthority`, wenn ein Helius-/DAS-RPC eingestellt ist. |

## Start

```bash
npm install
npm run dev
```

Netzwerk (Devnet/Mainnet) und eigene RPC-URLs stellst du oben rechts ein (Pill + ⚙). Für Mainnet einen eigenen RPC verwenden (Helius, QuickNode …); der öffentliche Endpoint blockt Browser-Anfragen häufig.

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
npm run e2e        # echter Devnet-Durchlauf (Token → Pool → 50 % Liquidität entfernen) mit Wegwerf-Keypair; braucht ~1 Devnet-SOL
```

`e2e` legt `scripts/.devnet-keypair.json` an. Wenn der Airdrop fehlschlägt, die angezeigte Adresse über https://faucet.solana.com aufladen und erneut starten.

## Produktion

`npm run build` → statische Dateien in `dist/`, deploybar auf Vercel, Netlify, Cloudflare Pages o. ä.

## Stack

Vite + React + TypeScript · `@solana/wallet-adapter` · Metaplex Umi (`mpl-token-metadata`, `mpl-toolbox`, Irys-Uploader) · `@raydium-io/raydium-sdk-v2` (CPMM)
