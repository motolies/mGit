import { describe, expect, it } from 'vitest';
import { queryTokens, rankFiles, repoOf } from '../features/search/fuzzy';

/** 검색어로 고른 경로 순서 */
function order(files: string[], query: string, recent: string[] = []): string[] {
  return rankFiles(files, query, recent).items.map((item) => item.path);
}

describe('빠른 열기 퍼지 순위', () => {
  // [무엇을 보는지, 검색어, 후보, 기대 순서, 최근 목록]
  const table: [string, string, string[], string[], string[]?][] = [
    [
      '파일 이름 안의 일치가 경로 일치보다 앞',
      'main',
      ['main/src/app.ts', 'src/main.ts'],
      ['src/main.ts', 'main/src/app.ts'],
    ],
    [
      '이어진 일치가 흩어진 일치보다 앞',
      'abc',
      ['lib/axbxcx.ts', 'lib/abcdef.ts'],
      ['lib/abcdef.ts', 'lib/axbxcx.ts'],
    ],
    [
      '단어 경계(- 뒤)에서 시작한 일치가 앞',
      'gs',
      ['src/ages.ts', 'src/git-status.ts'],
      ['src/git-status.ts', 'src/ages.ts'],
    ],
    [
      'camelCase 대문자 경계가 앞',
      'fe',
      ['src/Fixtures.tsx', 'src/FileEditor.tsx'],
      ['src/FileEditor.tsx', 'src/Fixtures.tsx'],
    ],
    [
      '같은 일치면 짧은 경로가 앞',
      'readme',
      ['docs/guide/README.md', 'README.md'],
      ['README.md', 'docs/guide/README.md'],
    ],
    [
      '같은 일치면 최근에 연 파일이 앞',
      'index',
      ['a/index.ts', 'b/index.ts'],
      ['b/index.ts', 'a/index.ts'],
      ['b/index.ts'],
    ],
    [
      '최근 가중은 파일 이름 일치를 넘지 않는다',
      'main',
      ['main/src/app.ts', 'src/main.ts'],
      ['src/main.ts', 'main/src/app.ts'],
      ['main/src/app.ts'],
    ],
    ['부분 순서가 아니면 빠진다', 'tsx', ['a.ts', 'b.tsx', 'x/t/s/x'], ['b.tsx', 'x/t/s/x']],
  ];
  it.each(table)('%s', (_name, query, files, expected, recent = []) => {
    expect(order(files, query, recent)).toEqual(expected);
  });

  it('여러 낱말은 순서와 상관없이 모두 맞아야 하고 대소문자를 무시한다', () => {
    const files = ['src/FileEditor.tsx', 'src/file.ts', 'src/editor/index.ts'];
    expect(order(files, 'editor file')).toEqual(['src/FileEditor.tsx']);
    expect(order(files, 'file editor')).toEqual(['src/FileEditor.tsx']);
    expect(order(files, 'FILEEDITOR')).toEqual(['src/FileEditor.tsx']);
    expect(order(files, '  ')).toEqual(files);
  });

  it('맞은 글자 위치를 돌려주고 여러 낱말의 위치를 합친다', () => {
    const [hit] = rankFiles(['src/FileEditor.tsx'], 'fe', []).items;
    expect(hit?.positions).toEqual([4, 8]);
    const [both] = rankFiles(['src/FileEditor.tsx'], 'tsx file', []).items;
    expect(both?.positions).toEqual([4, 5, 6, 7, 15, 16, 17]);
  });

  it('한글 경로도 맞추고, 조합 중 끝에 홀로 선 자모는 떼고 본다', () => {
    const files = ['docs/편집기-안내.md', 'docs/안내.md'];
    expect(order(files, '편집')).toEqual(['docs/편집기-안내.md']);
    expect(order(files, '편집ㄱ')).toEqual(['docs/편집기-안내.md']);
    expect(rankFiles(files, '편집', []).items[0]?.positions).toEqual([5, 6]);
    expect(queryTokens('a  b ㅂ')).toEqual(['a', 'b']);
  });

  it('빈 검색어는 최근에 연 순서를 앞에 두고 나머지는 목록 순서이며 결과 수를 센다', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    const result = rankFiles(files, '', ['c.ts', 'gone.ts', 'a.ts'], 3);
    expect(result.items.map((item) => item.path)).toEqual(['c.ts', 'a.ts', 'b.ts']);
    expect(result.total).toBe(4);
    const matched = rankFiles(files, 'ts', [], 2);
    expect(matched.items).toHaveLength(2);
    expect(matched.total).toBe(4);
  });

  it('파일의 저장소는 그 파일을 품은 가장 긴 저장소 디렉터리다', () => {
    const repos = ['', 'apps', 'apps/web'];
    expect(repoOf('apps/web/src/a.ts', repos)).toBe('apps/web');
    expect(repoOf('apps/webx/a.ts', repos)).toBe('apps');
    expect(repoOf('README.md', repos)).toBe('');
    expect(repoOf('loose/a.ts', ['apps'])).toBeNull();
  });

  it('1만·10만 경로에서 한 번 입력당 순위 계산이 화면을 멈추지 않을 만큼 빠르다', () => {
    const words = ['src', 'lib', 'app', 'core', 'ui', 'docs', 'test', 'utils', 'feature', 'store'];
    const names = ['index', 'FileEditor', 'workspace', 'git-status', 'README', 'config', 'helper'];
    const exts = ['ts', 'tsx', 'md', 'json', 'rs'];
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const make = (count: number) =>
      Array.from({ length: count }, (_, i) => {
        const depth = 2 + next(5);
        const dirs = Array.from({ length: depth }, () => words[next(words.length)]);
        return `${dirs.join('/')}/${names[next(names.length)]}${i}.${exts[next(exts.length)]}`;
      });
    const report: string[] = [];
    for (const count of [10_000, 100_000]) {
      const files = make(count);
      for (const query of ['a', 'fe', 'workspace', 'src cfg']) {
        const start = performance.now();
        const result = rankFiles(files, query, []);
        const elapsed = performance.now() - start;
        report.push(`${count} ${JSON.stringify(query)} ${elapsed.toFixed(1)}ms (${result.total})`);
        // 실제 시간은 보고용이다. 느린 CI 에서도 깨지지 않게 넉넉한 상한만 둔다
        expect(elapsed).toBeLessThan(count === 10_000 ? 1500 : 5000);
      }
    }
    if (process.env.MGIT_FUZZY_BENCH) console.info(report.join('\n'));
  });
});
