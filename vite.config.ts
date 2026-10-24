import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Solana/Metaplex/Raydium libs expect Node globals (Buffer, process) in the browser
export default defineConfig({
  // Relative asset paths so the build works under any sub-path (e.g. GitHub Pages /coinforge/)
  base: './',
  plugins: [react(), nodePolyfills({ globals: { Buffer: true, process: true, global: true } })],
})
