import { defineConfig } from 'vitest/config';
import { testCacheDir } from '../../scripts/test-cache.ts';

export default defineConfig({
  cacheDir: testCacheDir('diff-view'),
  test: {
    name: 'diff-view',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
    // vitest 는 CSS import 를 빈 내용으로 바꾼다. 줄 높이 가정을 대조하는 테스트가 `?raw` 로 읽는 원문만 그대로 둔다
    css: { include: [/\.css\?raw$/] },
  },
});
