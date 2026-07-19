import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Transport crypto worker: a worker_threads entry spawned by
          // transport-send-worker-host.ts via join(__dirname, ...). Emitted as
          // its own chunk next to the main bundle so the path resolves in both
          // dev and packaged builds.
          'transport-crypto-worker': resolve(__dirname, 'src/main/remote/transport-crypto-worker.ts')
        },
        output: {
          // Keep entry names stable (no hash) — the host resolves the worker
          // artifact by filename at runtime.
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          atv: resolve(__dirname, 'src/renderer/atv.html')
        }
      }
    }
  }
})
