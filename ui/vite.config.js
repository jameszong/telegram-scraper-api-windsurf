import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/auth': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/channels': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/sync': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/messages': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/media': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      }
    }
  }
})
