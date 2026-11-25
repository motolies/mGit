import { defineConfig } from 'vitest/config';
import { testCacheDir } from '../../scripts/test-cache.ts';

export default defineConfig({
  cacheDir: testCacheDir('desktop'),
  test: {
    name: 'desktop',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
