import { describe, expect, it } from 'vitest';
import {
  ancestorDirs,
  baseName,
  childPath,
  innermostRepo,
  isWithin,
  joinRoot,
  parentDir,
  relativeTo,
  repoToRoot,
  rootToRepo,
} from '../store/fs-path';

describe('상대 경로 다루기', () => {
  it('부모·마지막 구성요소·자식 경로', () => {
    expect(parentDir('')).toBeNull();
    expect(parentDir('a')).toBe('');
    expect(parentDir('a/b/c.ts')).toBe('a/b');
    expect(baseName('a/b/c.ts')).toBe('c.ts');
    expect(baseName('a')).toBe('a');
    expect(childPath('', 'a')).toBe('a');
    expect(childPath('a/b', 'c')).toBe('a/b/c');
  });

  it('조상 디렉터리는 루트부터 부모까지다', () => {
    expect(ancestorDirs('')).toEqual([]);
    expect(ancestorDirs('a')).toEqual(['']);
    expect(ancestorDirs('a/b/c')).toEqual(['', 'a', 'a/b']);
  });

  it('안에 있는지: 자신과 그 아래만, 이름이 접두로 겹치는 형제는 아니다', () => {
    expect(isWithin('a/b', '')).toBe(true);
    expect(isWithin('api', 'api')).toBe(true);
    expect(isWithin('api/src', 'api')).toBe(true);
    expect(isWithin('api-v2/src', 'api')).toBe(false);
  });
});

describe('상대 ↔ 절대 경로', () => {
  it('루트 끝의 / 는 하나로 본다', () => {
    expect(joinRoot('/w/acme', '')).toBe('/w/acme');
    expect(joinRoot('/w/acme/', '')).toBe('/w/acme');
    expect(joinRoot('/w/acme/', 'api/src')).toBe('/w/acme/api/src');
    expect(joinRoot('/', '')).toBe('/');
    expect(joinRoot('/', 'etc')).toBe('/etc');
  });

  it('절대 경로를 상대 경로로 바꾸고, 루트 밖이면 null 이다', () => {
    expect(relativeTo('/w/acme', '/w/acme')).toBe('');
    expect(relativeTo('/w/acme/', '/w/acme/api')).toBe('api');
    expect(relativeTo('/w/acme', '/w/acme/api/src/')).toBe('api/src');
    // 이름이 접두로 겹치는 형제 폴더는 밖이다
    expect(relativeTo('/w/acme', '/w/acme-v2/api')).toBeNull();
    expect(relativeTo('/w/acme', '/w')).toBeNull();
    expect(relativeTo('/', '/etc/hosts')).toBe('etc/hosts');
  });

  it('가장 안쪽 저장소: 조상인 저장소 중 가장 긴 것, 접두로 겹치는 형제는 아니다 (WS-07)', () => {
    const repos = ['/w/api', '/w/api-v2', '/w/libs/core', '/w/libs/core/vendor/sub'];
    expect(innermostRepo(repos, '/w/api')).toBe('/w/api');
    expect(innermostRepo(repos, '/w/api/src/Main.java')).toBe('/w/api');
    expect(innermostRepo(repos, '/w/api-v2/README.md')).toBe('/w/api-v2');
    // 하위 폴더 안의 저장소, 저장소 안의 중첩 저장소
    expect(innermostRepo(repos, '/w/libs/core/src/a.ts')).toBe('/w/libs/core');
    expect(innermostRepo(repos, '/w/libs/core/vendor/sub/x.c')).toBe('/w/libs/core/vendor/sub');
    // 저장소 밖
    expect(innermostRepo(repos, '/w/libs')).toBeNull();
    expect(innermostRepo(repos, '/w/README.md')).toBeNull();
    expect(innermostRepo([], '/w/api')).toBeNull();
    // 저장소 경로 끝의 / 도 같게 본다
    expect(innermostRepo(['/w/api/'], '/w/api/a')).toBe('/w/api/');
  });
});

describe('저장소 기준 경로 → 루트 기준 경로 (PT-06)', () => {
  it('저장소의 루트 기준 위치를 앞에 붙인다. 접두로 겹치는 형제 저장소는 섞지 않는다', () => {
    expect(repoToRoot('/w', '/w/api', 'src/Main.java')).toBe('api/src/Main.java');
    expect(repoToRoot('/w', '/w/api-v2', 'src/Main.java')).toBe('api-v2/src/Main.java');
    expect(repoToRoot('/w/', '/w/libs/core', 'a.ts')).toBe('libs/core/a.ts');
  });

  it('끝의 / (git 이 디렉터리 하나로 알린 untracked) 는 떼고, 빈 경로는 저장소 자신이다', () => {
    expect(repoToRoot('/w', '/w/api', 'vendor/sub/')).toBe('api/vendor/sub');
    expect(repoToRoot('/w', '/w/api', '')).toBe('api');
  });

  it('루트 자신인 저장소는 그대로, 루트 밖 저장소는 null', () => {
    expect(repoToRoot('/w', '/w', 'a.ts')).toBe('a.ts');
    expect(repoToRoot('/w/acme', '/w/acme-old', 'a.ts')).toBeNull();
    expect(repoToRoot('/w/acme', '/elsewhere/api', 'a.ts')).toBeNull();
  });
});

describe('루트 기준 경로 → (가장 안쪽 저장소, 저장소 기준 경로) (W13, 결정 19번)', () => {
  const repos = ['/w/api', '/w/api/vendor/lib', '/w/api-v2'];

  it('가장 안쪽 저장소와 그 저장소 기준 경로로 바꾼다. 접두로 겹치는 형제 저장소는 섞지 않는다', () => {
    expect(rootToRepo('/w', repos, 'api/src/Main.java')).toEqual({
      repoPath: '/w/api',
      path: 'src/Main.java',
    });
    expect(rootToRepo('/w', repos, 'api/vendor/lib/a.ts')).toEqual({
      repoPath: '/w/api/vendor/lib',
      path: 'a.ts',
    });
    expect(rootToRepo('/w/', repos, 'api-v2/pom.xml')).toEqual({
      repoPath: '/w/api-v2',
      path: 'pom.xml',
    });
    // repoToRoot 의 반대
    expect(repoToRoot('/w', '/w/api/vendor/lib', 'a.ts')).toBe('api/vendor/lib/a.ts');
  });

  it('저장소 밖이거나 저장소 디렉터리 자신이면 null', () => {
    expect(rootToRepo('/w', repos, 'README.md')).toBeNull();
    expect(rootToRepo('/w', repos, 'api')).toBeNull();
    expect(rootToRepo('/w', repos, '')).toBeNull();
    expect(rootToRepo('/w', [], 'api/a.ts')).toBeNull();
  });
});
