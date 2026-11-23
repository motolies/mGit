import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ui',
    environment: 'jsdom',
    setupFiles: ['../../vitest.setup.ts'],
    // vitest 는 CSS import 를 빈 내용으로 바꾼다. 토큰·아이콘 대조 테스트가 `?raw` 로 읽는 원문만 그대로 둔다
    css: { include: [/\.css\?raw$/] },
  },
});
