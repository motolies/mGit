import type { FileState, RepoChanges, StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import { buildStatusLookup, entryStatus } from '../features/project/file-status';

const ROOT = '/w/acme';

/** 상태 엔트리 하나 */
function entry(
  path: string,
  index: FileState,
  worktree: FileState,
  extra: Partial<StatusEntry> = {},
): StatusEntry {
  return {
    path,
    origPath: null,
    index,
    worktree,
    submodule: null,
    conflict: null,
    renameScore: null,
    ...extra,
  };
}

/** 저장소 하나의 변경 목록 */
function repo(rel: string, entries: StatusEntry[]): RepoChanges {
  return {
    path: `${ROOT}/${rel}`,
    name: rel,
    branch: 'main',
    entries,
    summary: {
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      ahead: 0,
      behind: 0,
      stashCount: 0,
      upstream: null,
    },
  };
}

/** 상태의 [색 갈래, 문자] (없으면 null) */
const shape = (status: ReturnType<typeof entryStatus>) =>
  status === null ? null : [status.tone, status.letter];

describe('entryStatus (PT-06, LF-05)', () => {
  it('엔트리 종류마다 색 갈래와 W8 과 같은 상태 문자', () => {
    expect(shape(entryStatus(entry('a', 'modified', 'unmodified')))).toEqual(['modified', 'M']);
    expect(shape(entryStatus(entry('a', 'unmodified', 'modified')))).toEqual(['modified', 'M']);
    expect(shape(entryStatus(entry('a', 'modified', 'modified')))).toEqual(['modified', 'M']);
    expect(shape(entryStatus(entry('a', 'added', 'unmodified')))).toEqual(['added', 'A']);
    // stage 된 새 파일을 다시 고쳐도 "추가"
    expect(shape(entryStatus(entry('a', 'added', 'modified')))).toEqual(['added', 'A']);
    expect(shape(entryStatus(entry('a', 'copied', 'unmodified')))).toEqual(['added', 'C']);
    expect(shape(entryStatus(entry('a', 'typeChanged', 'unmodified')))).toEqual(['modified', 'T']);
    expect(shape(entryStatus(entry('a', 'untracked', 'untracked')))).toEqual(['untracked', '?']);
  });

  it('충돌은 index·작업 트리 상태와 무관하게 충돌이다', () => {
    const conflict = entryStatus(entry('a', 'unmerged', 'unmerged', { conflict: 'bothModified' }));
    expect(shape(conflict)).toEqual(['conflict', 'U']);
    expect(conflict?.title).toBe(S.project.fileStatus.conflict);
    expect(
      shape(entryStatus(entry('a', 'added', 'deleted', { conflict: 'deletedByThem' }))),
    ).toEqual(['conflict', 'U']);
  });

  it('디스크에 없는 파일(삭제)은 상태가 없다. 이름 변경은 새 경로의 상태이고 툴팁에 원래 이름', () => {
    expect(entryStatus(entry('a', 'unmodified', 'deleted'))).toBeNull();
    expect(entryStatus(entry('a', 'deleted', 'unmodified'))).toBeNull();
    expect(entryStatus(entry('a', 'modified', 'deleted'))).toBeNull();
    expect(entryStatus(entry('a', 'unmodified', 'unmodified'))).toBeNull();
    const renamed = entryStatus(entry('new.ts', 'renamed', 'unmodified', { origPath: 'old.ts' }));
    expect(shape(renamed)).toEqual(['modified', 'R']);
    expect(renamed?.title).toBe(S.project.fileStatus.renamedFrom('old.ts'));
  });
});

describe('buildStatusLookup (PT-06)', () => {
  const tone = (lookup: ReturnType<typeof buildStatusLookup>, path: string) =>
    shape(lookup.get(path));

  it('저장소 기준 경로를 루트 기준 경로로 옮겨 칠한다. 접두로 겹치는 형제 저장소는 섞지 않는다', () => {
    const lookup = buildStatusLookup(
      ROOT,
      [`${ROOT}/api`, `${ROOT}/api-v2`],
      [
        repo('api', [entry('src/Main.java', 'modified', 'unmodified')]),
        repo('api-v2', [entry('src/New.java', 'added', 'unmodified')]),
      ],
    );
    expect(tone(lookup, 'api/src/Main.java')).toEqual(['modified', 'M']);
    expect(tone(lookup, 'api-v2/src/New.java')).toEqual(['added', 'A']);
    expect(lookup.get('api/src/New.java')).toBeNull();
    expect(lookup.get('api-v2/src/Main.java')).toBeNull();
  });

  it('중첩 저장소: 바깥 저장소의 엔트리는 안쪽 저장소의 경로(그 디렉터리 포함)에 칠해지지 않는다', () => {
    const lookup = buildStatusLookup(
      ROOT,
      [`${ROOT}/outer`, `${ROOT}/outer/vendor/inner`],
      [
        repo('outer', [
          entry('README.md', 'unmodified', 'modified'),
          // git 은 안쪽 저장소를 디렉터리 하나로 untracked 라고 알린다
          entry('vendor/inner/', 'untracked', 'untracked'),
          entry('vendor/inner/lib.c', 'unmodified', 'modified'),
        ]),
        repo('outer/vendor/inner', [entry('lib.c', 'added', 'unmodified')]),
      ],
    );
    expect(tone(lookup, 'outer/README.md')).toEqual(['modified', 'M']);
    // 안쪽 저장소 행은 자기 변경이 있어 "안에 변경 있음" 이지 바깥의 untracked 가 아니다
    expect(lookup.get('outer/vendor/inner')?.letter).toBeNull();
    expect(tone(lookup, 'outer/vendor/inner/lib.c')).toEqual(['added', 'A']);
  });

  it('통째로 untracked 인 디렉터리(`dir/`)는 그 디렉터리와 그 아래 항목이 untracked 다', () => {
    const lookup = buildStatusLookup(
      ROOT,
      [`${ROOT}/api`],
      [repo('api', [entry('scratch/', 'untracked', 'untracked')])],
    );
    expect(tone(lookup, 'api/scratch')).toEqual(['untracked', '?']);
    expect(tone(lookup, 'api/scratch/notes.md')).toEqual(['untracked', '?']);
    expect(tone(lookup, 'api/scratch/deep/x.txt')).toEqual(['untracked', '?']);
    expect(lookup.get('api/scratchpad.md')).toBeNull();
  });

  it('같은 경로에 둘이 오면 충돌 > 추가 > 수정 > untracked', () => {
    const lookup = buildStatusLookup(
      ROOT,
      [`${ROOT}/api`],
      [
        repo('api', [
          entry('a.ts', 'untracked', 'untracked'),
          entry('a.ts', 'unmerged', 'unmerged', { conflict: 'bothAdded' }),
          entry('b.ts', 'untracked', 'untracked'),
          entry('b.ts', 'modified', 'unmodified'),
          // index 에서 지우고(`git rm --cached`) 디스크에 남은 파일: untracked 로 보인다
          entry('c.ts', 'deleted', 'unmodified'),
          entry('c.ts', 'untracked', 'untracked'),
        ]),
      ],
    );
    expect(tone(lookup, 'api/a.ts')).toEqual(['conflict', 'U']);
    expect(tone(lookup, 'api/b.ts')).toEqual(['modified', 'M']);
    expect(tone(lookup, 'api/c.ts')).toEqual(['untracked', '?']);
  });

  it('안에 변경이 있는 디렉터리(저장소 행·그 위 폴더 포함)는 문자 없이 "수정" 색, 루트는 칠하지 않는다', () => {
    const lookup = buildStatusLookup(
      ROOT,
      [`${ROOT}/group/api`],
      [repo('group/api', [entry('src/a/b.ts', 'untracked', 'untracked')])],
    );
    for (const dir of ['group/api/src/a', 'group/api/src', 'group/api', 'group']) {
      expect(lookup.get(dir), dir).toEqual({
        tone: 'modified',
        letter: null,
        title: S.project.fileStatus.inside,
      });
    }
    expect(lookup.get('')).toBeNull();
    expect(lookup.get('group/other')).toBeNull();
  });

  it('변경 목록이 비면 아무것도 칠하지 않는다', () => {
    expect(buildStatusLookup(ROOT, [`${ROOT}/api`], []).get('api')).toBeNull();
  });
});
