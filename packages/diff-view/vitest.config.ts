import { defineConfig } from 'vitest/config';
import { testCacheDir } from '../../scripts/test-cache.ts';

export default defineConfig({
  cacheDir: testCacheDir('diff-view'),
  test: {
    name: 'diff-view',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
