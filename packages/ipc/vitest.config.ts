import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ipc',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
