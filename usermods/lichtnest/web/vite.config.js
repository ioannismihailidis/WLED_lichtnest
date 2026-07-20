import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// Build the whole app into a single self-contained index.html (all JS + CSS
// inlined), so deploying the UI to the device is a single gzipped file upload.
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  define: {
    __LN_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2019',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000,
    reportCompressedSize: false,
  },
})
