import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
