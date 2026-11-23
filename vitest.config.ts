import { defineConfig } from 'vitest/config';

// 각 디렉터리의 vitest.config.ts 를 프로젝트로 묶어 한 번에 실행한다
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/desktop'],
  },
});
