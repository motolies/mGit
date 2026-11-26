import { createNullClient } from '@mgit/ipc';
import { afterEach, describe, expect, it } from 'vitest';
import { createFolderStore } from '../store/folder-store';
import {
  joinRoot,
  relativeTo,
  repoToRoot,
  repoToRootIn,
  rootToRepo,
  rootToRepoIn,
} from '../store/fs-path';
import { dirSpace, GROUP_KEY_PREFIX, isGroupKey, type RootSpace } from '../store/root-space';
import { disposeFolder, registerFolder } from '../store/session-registry';
import { spaceOf, tabSpace } from '../store/session-space';

// 디렉터리 공간(`dirSpace`)은 기존 `joinRoot`·`relativeTo` 와 같은 값을 낸다 (MR-13 M0b: 동작 변화 없음).
// 표마다 기대값과 기존 함수의 값을 함께 확인한다 — 기존 함수가 바뀌면 이 표가 먼저 깨진다.

/** [이름, 루트, 루트 기준 상대 경로, 절대 경로] */
const TO_ABS: [string, string, string, string][] = [
  ['루트 자신', '/w/acme', '', '/w/acme'],
  ['루트 끝 슬래시', '/w/acme/', '', '/w/acme'],
  ['루트 끝 슬래시 여러 개', '/w/acme//', 'api', '/w/acme/api'],
  ['하위 파일', '/w/acme', 'api/src/Main.java', '/w/acme/api/src/Main.java'],
  ['하위 디렉터리 (루트 끝 슬래시)', '/w/acme/', 'api/src', '/w/acme/api/src'],
  ['파일 시스템 루트 자신', '/', '', '/'],
  ['파일 시스템 루트 아래', '/', 'etc', '/etc'],
  ['공백·한글', '/w/my repo', '한글 폴더/파일 이름.ts', '/w/my repo/한글 폴더/파일 이름.ts'],
  // 구분자는 `/` 만 본다: Windows 구분자를 바꾸지 않고 그대로 잇는다 (기존과 같음)
  ['Windows 구분자 루트', 'C:\\w\\acme', 'api', 'C:\\w\\acme/api'],
  ['Windows 구분자 루트 자신', 'C:\\w\\acme\\', '', 'C:\\w\\acme\\'],
];

/** [이름, 루트, 절대 경로, 루트 기준 상대 경로 (밖이면 null)] */
const TO_REL: [string, string, string, string | null][] = [
  ['루트 자신', '/w/acme', '/w/acme', ''],
  ['루트 자신 (대상 끝 슬래시)', '/w/acme', '/w/acme/', ''],
  ['루트 자신 (루트 끝 슬래시)', '/w/acme/', '/w/acme', ''],
  ['하위', '/w/acme/', '/w/acme/api', 'api'],
  ['하위 (대상 끝 슬래시)', '/w/acme', '/w/acme/api/src/', 'api/src'],
  ['형제 접두 (/a/b 와 /a/bc)', '/a/b', '/a/bc', null],
  ['형제 접두 아래', '/a/b', '/a/bc/d', null],
  ['더 짧은 형제', '/a/bc', '/a/b', null],
  ['상위', '/w/acme', '/w', null],
  ['다른 트리', '/w/acme', '/elsewhere/api', null],
  ['파일 시스템 루트', '/', '/etc/hosts', 'etc/hosts'],
  ['공백·한글', '/w/my repo', '/w/my repo/한글 폴더/파일.ts', '한글 폴더/파일.ts'],
  ['공백 이름의 형제 접두', '/w/my repo', '/w/my repo2/a', null],
  // 역슬래시는 구분자로 보지 않는다 (기존과 같음): 같은 문자열이면 루트 자신, 아래는 밖이다
  ['Windows 구분자 루트 자신', 'C:\\w\\acme', 'C:\\w\\acme', ''],
  ['Windows 구분자 하위', 'C:\\w\\acme', 'C:\\w\\acme\\api', null],
  ['드라이브 + / 구분자', 'C:/w/acme', 'C:/w/acme/api', 'api'],
];

describe('dirSpace — 기존 joinRoot·relativeTo 와 같은 값 (MR-13 M0b)', () => {
  it.each(TO_ABS)('toAbs: %s', (_name, root, rel, abs) => {
    expect(dirSpace(root).toAbs(rel)).toBe(abs);
    expect(dirSpace(root).toAbs(rel)).toBe(joinRoot(root, rel));
  });

  it.each(TO_REL)('toRel: %s', (_name, root, abs, rel) => {
    expect(dirSpace(root).toRel(abs)).toBe(rel);
    expect(dirSpace(root).toRel(abs)).toBe(relativeTo(root, abs));
  });

  it('키·디렉터리는 받은 경로 그대로다 (탭·저장 키와 같아야 한다)', () => {
    const space = dirSpace('/w/acme/');
    expect(space.key).toBe('/w/acme/');
    expect(space.dir).toBe('/w/acme/');
  });

  it('끝 슬래시 없는 상대 경로는 왕복해도 같다', () => {
    for (const root of ['/w/acme', '/w/acme/', '/', '/w/my repo']) {
      const space = dirSpace(root);
      for (const rel of ['', 'api', 'api/src/Main.java', '한글 폴더/파일 이름.ts']) {
        const abs = space.toAbs(rel);
        expect(abs === null ? null : space.toRel(abs)).toBe(rel);
      }
    }
  });
});

describe('경로 공간 판 (`…In`) — 디렉터리 공간이면 문자열 판과 같다', () => {
  const ROOTS = ['/w', '/w/', '/w/acme'];
  const REPOS = ['/w/api', '/w/api-v2', '/w/api/vendor/lib', '/w/acme'];

  it('repoToRootIn', () => {
    const cases: [string, string][] = [
      ['/w/api', 'src/Main.java'],
      ['/w/api-v2', 'pom.xml'],
      ['/w/api', 'vendor/sub/'],
      ['/w/api', ''],
      ['/w', 'a.ts'],
      ['/w/acme-old', 'a.ts'],
      ['/elsewhere/api', 'a.ts'],
    ];
    for (const root of ROOTS) {
      for (const [repoPath, repoRel] of cases) {
        expect(repoToRootIn(dirSpace(root), repoPath, repoRel)).toBe(
          repoToRoot(root, repoPath, repoRel),
        );
      }
    }
  });

  it('rootToRepoIn', () => {
    const rels = [
      'api/src/Main.java',
      'api/vendor/lib/a.ts',
      'api-v2/pom.xml',
      'README.md',
      'api',
      '',
    ];
    for (const root of ROOTS) {
      for (const rel of rels) {
        expect(rootToRepoIn(dirSpace(root), REPOS, rel)).toEqual(rootToRepo(root, REPOS, rel));
      }
    }
  });

  it('공간이 절대 경로로 바꾸지 못하는 자리(그룹 맨 위)는 null 이다', () => {
    const top: RootSpace = {
      key: `${GROUP_KEY_PREFIX}g1`,
      dir: null,
      toAbs: (rel) => (rel.startsWith('api/') ? `/w/api/${rel.slice(4)}` : null),
      toRel: (abs) => (abs.startsWith('/w/api/') ? `api/${abs.slice(7)}` : null),
    };
    expect(rootToRepoIn(top, REPOS, '')).toBeNull();
    expect(rootToRepoIn(top, REPOS, 'api/src/a.ts')).toEqual({
      repoPath: '/w/api',
      path: 'src/a.ts',
    });
    expect(repoToRootIn(top, '/w/api/vendor/lib', 'a.ts')).toBe('api/vendor/lib/a.ts');
    expect(repoToRootIn(top, '/w/web', 'a.ts')).toBeNull();
  });
});

describe('세션 키 — 그룹 키 구분과 탭 공간', () => {
  const ID = 9301;
  afterEach(() => disposeFolder(ID));

  it('isGroupKey 는 그룹 키 접두만 본다', () => {
    expect(isGroupKey('mgit-group:g0123456789ab')).toBe(true);
    expect(isGroupKey('/w/mgit-group:x')).toBe(false);
    expect(isGroupKey('/w/acme')).toBe(false);
  });

  it('디렉터리 키는 스토어 없이도 그 디렉터리 공간, 등록된 폴더는 같은 값을 낸다', () => {
    expect(tabSpace(ID, '/w/acme')?.toAbs('api')).toBe('/w/acme/api');
    expect(spaceOf(ID)).toBeNull();
    registerFolder(
      ID,
      createFolderStore({ session: ID, path: '/w/acme', repos: [] }, createNullClient()),
    );
    expect(spaceOf(ID)?.toAbs('api')).toBe('/w/acme/api');
    expect(spaceOf(ID)?.toRel('/w/acme-v2')).toBeNull();
  });

  it('그룹 키는 등록된 폴더 스토어의 공간이고, 없으면 null 이다', () => {
    const key = `${GROUP_KEY_PREFIX}g1`;
    expect(tabSpace(ID, key)).toBeNull();
    const store = createFolderStore({ session: ID, path: key, repos: [] }, createNullClient());
    const group: RootSpace = { key, dir: null, toAbs: () => null, toRel: () => null };
    store.setState({ space: group });
    registerFolder(ID, store);
    expect(tabSpace(ID, key)).toBe(group);
    expect(spaceOf(ID)).toBe(group);
  });
});
