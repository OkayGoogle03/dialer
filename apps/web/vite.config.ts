import { defaultClientConditions, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API is proxied so the refresh cookie (path /api/v1/auth, SameSite=Strict) is same-origin in dev.
export default defineConfig({
  plugins: [react()],
  // Consume workspace packages from source (exports "source" condition) so no pre-build is needed in dev.
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.VITE_API_PROXY ?? 'http://localhost:3000', changeOrigin: false } },
  },
  test: { environment: 'node' },
});
