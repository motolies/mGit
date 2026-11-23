import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'diff-view',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
