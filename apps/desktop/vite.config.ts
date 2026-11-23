import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri 개발 서버 설정. 포트는 tauri.conf.json 의 devUrl 과 맞춘다.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  build: {
    target: 'safari18',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
