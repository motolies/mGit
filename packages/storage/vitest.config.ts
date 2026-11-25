import { defineConfig } from 'vitest/config';
import { testCacheDir } from '../../scripts/test-cache.ts';

export default defineConfig({
  cacheDir: testCacheDir('storage'),
  test: { name: 'storage', environment: 'jsdom' },
});
