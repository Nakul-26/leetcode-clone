import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // y-monaco (used by the Phase D interview room's collaborative editor) deep-imports
      // this exact path, but monaco-editor's own package.json "exports" map no longer
      // allows it (newer monaco-editor versions dropped the "esm/vs/" prefix from their
      // subpath exports, y-monaco hasn't caught up) - alias straight to the file on disk,
      // which bypasses "exports" resolution and works since the file itself still exists.
      'monaco-editor/esm/vs/editor/editor.api.js': fileURLToPath(
        new URL('./node_modules/monaco-editor/esm/vs/editor/editor.api.js', import.meta.url)
      ),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://assessment-api:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api'),
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'monaco': ['@monaco-editor/react'],
          'exceljs': ['exceljs'],
          'vendor': ['react', 'react-dom', 'react-router-dom', 'framer-motion', 'lucide-react'],
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
})
