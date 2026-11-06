import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard talks to the Nimpat One API. In development Vite proxies
// /api and /media to the API on :4000, so no CORS setup is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4000',
      '/media': 'http://localhost:4000',
    },
  },
});
