import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** jsdom 테스트 실행의 캐시를 checkout 내부 프로세스별 경로로 분리한다. */
export function testCacheDir(project: string): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return path.join(root, 'target', 'tests', String(process.pid), project);
}
