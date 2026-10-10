import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'

// Master UI: separate single-file build (dist-master/index.html -> master.htm.gz), served
// by a master device at "/". Shares components / styles with the Lichtnest UI in src/.
const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, root, '')
  const device = (env.ZV_MASTER || process.env.ZV_MASTER || env.ZV_HOST || process.env.ZV_HOST || '').replace(/\/$/, '')
  const proxying = command === 'serve' && !!device
  const opts = { target: device, changeOrigin: true }
  return {
    root: join(root, 'master'),
    plugins: [vue(), ...(command === 'build' ? [viteSingleFile()] : [])],
    define: {
      __LN_PROXY__: JSON.stringify(proxying),
      __UI_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      host: true,
      port: 5175,
      open: true,
      ...(proxying ? { proxy: { '/json': opts, '/upload': opts, '/edit': opts, '^/[^/]+\\.json$': opts } } : {}),
    },
    build: {
      outDir: join(root, 'dist-master'),
      emptyOutDir: true,
      target: 'es2019',
      cssCodeSplit: false,
      assetsInlineLimit: 100000000,
      chunkSizeWarningLimit: 100000,
      reportCompressedSize: false,
    },
  }
})
