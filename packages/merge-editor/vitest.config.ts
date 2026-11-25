import { defineConfig } from 'vitest/config';
import { testCacheDir } from '../../scripts/test-cache.ts';

export default defineConfig({
  cacheDir: testCacheDir('merge-editor'),
  test: {
    name: 'merge-editor',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
