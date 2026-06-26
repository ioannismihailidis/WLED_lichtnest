import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Build the whole app into a single self-contained index.html (all JS + CSS
// inlined), so deploying the UI to the device is a single gzipped file upload.
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  build: {
    target: 'es2019',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000,
    reportCompressedSize: false,
  },
})
