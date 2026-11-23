import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'merge-editor',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
