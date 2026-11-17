import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { fileURLToPath } from 'url';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'src',
  // Vitest: client tests live in src/, server tests in server/ (the Vite root
  // is src/, so point the scan at the repo root). NODE_ENV=test gives the
  // server an in-memory SQLite database.
  test: {
    dir: repoRoot,
    include: ['src/**/*.test.js', 'server/**/*.test.js'],
    environment: 'node',
  },
  plugins: [
    wasm(),
    topLevelAwait()
  ],
  server: {
    port: 5173,
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3000',
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Raise the warning threshold — WASM modules are legitimately large
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // Keep WASM files as separate chunks so Caddy/Express can serve them
        // with the correct Content-Type and cache headers
        manualChunks: undefined,
      },
    },
  },
});
