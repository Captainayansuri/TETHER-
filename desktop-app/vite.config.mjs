import { defineConfig } from 'vite';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const { buildRuntimeConfig } = require('./runtime-config');
const appConfig = buildRuntimeConfig({
  environment: process.env.NODE_ENV || 'development',
  env: process.env
});

export default defineConfig({
  base: './',
  server: {
    port: appConfig.dashboardDevPort,
    strictPort: true
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/index.html')
    }
  }
});
