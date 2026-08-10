import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Consume the workspace packages from source so a protocol change shows
      // up here without a rebuild step.
      '@vff/client-core': path.resolve(__dirname, '../../packages/client-core/src/index.ts'),
      '@vff/protocol': path.resolve(__dirname, '../../packages/protocol/src/index.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
    // The aliases above resolve to sibling workspace packages, which sit
    // outside this app's root. Without widening the allow-list to the
    // monorepo root, Vite refuses to serve them.
    fs: { allow: [path.resolve(__dirname, '../..')] },
  },
});
