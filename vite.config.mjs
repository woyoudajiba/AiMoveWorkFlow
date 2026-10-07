import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Keep the bundle portable between the web sub-path (/workf/) and the
// packaged Electron app, which both serve the same dist directory.
const base = process.env.VITE_BASE_PATH?.trim() || './';
export default defineConfig({
  base: base.endsWith('/') ? base : `${base}/`,
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:4318', '/media': 'http://127.0.0.1:4318', '/exports': 'http://127.0.0.1:4318' } },
  build: { outDir: 'dist' },
});
