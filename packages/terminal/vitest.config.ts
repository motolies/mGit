import { defineConfig } from 'vitest/config';
import { testCacheDir } from '../../scripts/test-cache.ts';

export default defineConfig({
  cacheDir: testCacheDir('terminal'),
  test: {
    name: 'terminal',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
