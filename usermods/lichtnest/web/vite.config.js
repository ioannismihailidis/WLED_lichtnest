import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))

function deviceProxy (target) {
  const opts = { target, changeOrigin: true }
  return {
    '/json': opts,
    '/ws': { ...opts, ws: true },
    '/upload': opts,
    '/edit': opts,
    '/settings': opts,
    '/update': opts,
    '/classic': opts,
    '/cfg.json': opts,
    '/presets.json': opts,
    '/plan.jpg': opts,
    '/lichtnest_plan.json': opts,
    '/lichtnest_playlists.json': opts,
  }
}

// Build → single self-contained index.html (JS+CSS inlined) for device upload.
// Dev → normal Vite HMR; optional ZV_HOST proxies API/WS to a live controller.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, root, '')
  const device = (env.ZV_HOST || process.env.ZV_HOST || '').replace(/\/$/, '')
  const proxying = command === 'serve' && !!device

  return {
    plugins: [
      vue(),
      ...(command === 'build' ? [viteSingleFile()] : []),
    ],
    define: {
      __LN_PROXY__: JSON.stringify(proxying),
    },
    server: {
      host: true,
      port: 5173,
      open: true,
      ...(proxying ? { proxy: deviceProxy(device) } : {}),
    },
    build: {
      target: 'es2019',
      cssCodeSplit: false,
      assetsInlineLimit: 100000000,
      chunkSizeWarningLimit: 100000,
      reportCompressedSize: false,
    },
  }
})
