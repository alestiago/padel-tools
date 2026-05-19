import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// onnxruntime-web bundles its WASM glue as a dynamic import with @vite-ignore,
// but Vite's dev server still rejects requests for files in public/ when they
// arrive as module fetches. Serve the .mjs glue file from node_modules via a
// plain middleware so it bypasses that check, and emit it as a build asset.
function onnxWasmPlugin(): Plugin {
  const MJS = 'ort-wasm-simd-threaded.mjs'
  const src = () => resolve(`node_modules/onnxruntime-web/dist/${MJS}`)
  return {
    name: 'onnx-wasm',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(`/${MJS}`, (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.end(readFileSync(src()))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: MJS, source: readFileSync(src()) })
    },
  }
}

// COOP/COEP headers enable SharedArrayBuffer, which onnxruntime-web needs for
// multi-threaded WASM inference.
const crossOriginHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

export default defineConfig({
  plugins: [react(), tailwindcss(), onnxWasmPlugin()],
  server:  { headers: crossOriginHeaders },
  preview: { headers: crossOriginHeaders },
})
