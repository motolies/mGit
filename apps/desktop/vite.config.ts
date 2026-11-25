import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 개발 런처가 바인딩한 주소를 Tauri에 전달하며 직접 Vite 실행도 loopback으로 제한한다.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    strictPort: false,
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
