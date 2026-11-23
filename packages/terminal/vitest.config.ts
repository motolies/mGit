import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'terminal',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
