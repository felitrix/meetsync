import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // Chrome pode rejeitar preloads de paginas chrome-extension:// quando o
    // recurso e o modulo acabam associados a execution worlds diferentes.
    // As paginas sao pequenas e carregam os chunks normalmente como ESM, entao
    // o preload nao traz ganho relevante e apenas gera o aviso no console.
    modulePreload: false,
    rollupOptions: {
      // Página de boas-vindas: não é referenciada no manifest (aberta via runtime.getURL),
      // então precisa ser declarada como entrada extra para o crxjs/Rollup empacotá-la.
      input: {
        options: resolve(__dirname, 'src/options/options.html'),
        welcome: resolve(__dirname, 'src/welcome/welcome.html'),
      },
    },
  },
  // O dev-server do crxjs usa websocket para HMR do content script.
  server: {
    cors: { origin: [/chrome-extension:\/\//] },
  },
});
