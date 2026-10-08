import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: ['.ts.net'],
    proxy: {
      '/api-ia': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        headers: { origin: 'http://localhost:5173' },
        rewrite: (ruta) => ruta.replace(/^\/api-ia/, ''),
      },
    },
  },
})