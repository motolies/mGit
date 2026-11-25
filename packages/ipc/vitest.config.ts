import { defineConfig } from 'vitest/config';
import { testCacheDir } from '../../scripts/test-cache.ts';

export default defineConfig({
  cacheDir: testCacheDir('ipc'),
  test: {
    name: 'ipc',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
  },
});
