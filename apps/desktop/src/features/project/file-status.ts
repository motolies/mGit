// 프로젝트 트리의 파일 상태 (W12, PT-06·LF-05). 폴더 스토어가 이미 읽는 저장소별 변경 엔트리(`folderChanges`,
// 통합 변경 보기와 같은 데이터)를 루트 기준 상대 경로의 행 상태로 바꾼다. 새 요청은 없다 — 한 저장소가 바뀌면
// 폴더 스토어의 부분 갱신이 그 저장소의 엔트리만 다시 읽고, 여기서는 받은 목록으로 색인을 다시 만든다.
//
// - 삭제된 파일은 디스크에 없어 트리에 행이 없으므로 상태를 만들지 않는다. 이름 변경은 새 경로에 붙는다.
// - status 는 `--untracked-files=all` 이라 untracked 디렉터리를 파일마다 알린다. 디렉터리 하나로 오는 것(`dir/`)은
//   git 이 내려가지 않는 중첩 저장소뿐이다 — 그 디렉터리와 그 아래 항목을 untracked 로 본다.
// - 중첩 저장소: 바깥 저장소의 엔트리가 안쪽 저장소의 경로(그 디렉터리 자신 포함)에 닿으면 버린다 (안쪽 저장소의
//   상태가 맡는다).
// - 안에 변경이 있는 디렉터리(접힌 저장소·디렉터리 포함)는 "수정" 색으로 이름만 칠한다 (IntelliJ 기본 동작).
//   루트 행은 칠하지 않는다.
// - 무시된 파일의 색은 만들지 않는다.

import type { RepoChanges, StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { ancestorDirs, isWithin, repoToRootIn } from '../../store/fs-path';
import { dirSpace, type RootSpace } from '../../store/root-space';

/** 상태의 색 갈래. 색은 `--status-<tone>` 토큰이다 */
export type StatusTone = 'modified' | 'added' | 'untracked' | 'conflict';

/** 트리 행 하나의 상태 */
export interface RowStatus {
  tone: StatusTone;
  /** 행 끝의 상태 문자 (W8 변경 파일 트리와 같은 글자). 디렉터리의 "안에 변경 있음" 은 null */
  letter: string | null;
  /** 상태 문자·이름의 툴팁 */
  title: string;
}

/** 같은 경로에 상태가 둘 오면 (예: index 에서 지우고 같은 파일을 untracked 로 둠) 큰 쪽을 쓴다 */
const RANK: Record<StatusTone, number> = { untracked: 1, modified: 2, added: 3, conflict: 4 };

/** 상태 하나 */
function mark(tone: StatusTone, letter: string, title: string): RowStatus {
  return { tone, letter, title };
}

/**
 * 상태 엔트리 하나를 행 상태로 (PT-06). 디스크에 없는 파일(작업 트리·index 에서 삭제)은 null.
 * 충돌 > untracked > index 쪽(추가·복사·이름 바뀜·종류 바뀜·수정) > 작업 트리 쪽(종류 바뀜·수정)
 */
export function entryStatus(e: StatusEntry): RowStatus | null {
  const t = S.project.fileStatus;
  if (e.conflict !== null || e.index === 'unmerged' || e.worktree === 'unmerged') {
    return mark('conflict', 'U', t.conflict);
  }
  if (e.worktree === 'deleted' || e.index === 'deleted') {
    return null;
  }
  if (e.worktree === 'untracked' || e.index === 'untracked') {
    return mark('untracked', '?', t.untracked);
  }
  switch (e.index) {
    case 'added':
      return mark('added', 'A', t.added);
    case 'copied':
      return mark('added', 'C', t.copied);
    case 'renamed':
      return mark('modified', 'R', e.origPath ? t.renamedFrom(e.origPath) : t.renamed);
    case 'typeChanged':
      return mark('modified', 'T', t.typeChanged);
    case 'modified':
      return mark('modified', 'M', t.modified);
    default:
      break;
  }
  switch (e.worktree) {
    case 'typeChanged':
      return mark('modified', 'T', t.typeChanged);
    case 'modified':
      return mark('modified', 'M', t.modified);
    default:
      return null;
  }
}

/** 상태 문자가 붙는 경로 하나 (보기 거르기 "변경된 파일만"의 후보, R1) */
export interface ChangedPath {
  /** 루트 기준 상대 경로 */
  path: string;
  /** 통째로 untracked 인 디렉터리 (git 이 내려가지 않는 중첩 저장소, `dir/`) */
  dir: boolean;
}

/** 루트 기준 상대 경로 → 행 상태 */
export interface StatusLookup {
  get(path: string): RowStatus | null;
  /** 상태 문자가 붙는 경로 전부 ("안에 변경 있음" 디렉터리는 빼고). 순서는 정하지 않는다 */
  changed(): readonly ChangedPath[];
}

/** 변경이 하나도 없을 때 */
const EMPTY_LOOKUP: StatusLookup = { get: () => null, changed: () => [] };

/**
 * 저장소별 변경 엔트리로 행 상태 색인을 만든다 (PT-06). `root` 는 트리 루트(폴더)의 절대 경로, `repoPaths` 는
 * 폴더의 저장소 절대 경로들(중첩 판정용). 경로마다 한 번 묻는 `get` 은 상수 시간 + 조상 수만큼이다. 디렉터리 하나인
 * 공간의 `buildStatusLookupIn` 이다 (저장소 탭)
 */
export function buildStatusLookup(
  root: string,
  repoPaths: readonly string[],
  changes: readonly RepoChanges[],
): StatusLookup {
  return buildStatusLookupIn(dirSpace(root), repoPaths, changes);
}

/** `buildStatusLookup` 의 경로 공간 판 (MR-13): 저장소·엔트리의 트리 경로를 공간의 `toRel` 로 찾는다 */
export function buildStatusLookupIn(
  space: RootSpace,
  repoPaths: readonly string[],
  changes: readonly RepoChanges[],
): StatusLookup {
  if (changes.length === 0) {
    return EMPTY_LOOKUP;
  }
  const repoRels = repoPaths.flatMap((p) => {
    const rel = space.toRel(p);
    return rel === null ? [] : [rel];
  });
  const own = new Map<string, RowStatus>();
  const untrackedDirs = new Set<string>();
  for (const repo of changes) {
    const base = space.toRel(repo.path);
    if (base === null) {
      continue;
    }
    // 이 저장소 안에 든 다른 저장소: 그 아래 엔트리는 안쪽 저장소의 것이다
    const nested = repoRels.filter((rel) => rel !== base && isWithin(rel, base));
    for (const e of repo.entries) {
      const path = repoToRootIn(space, repo.path, e.path);
      if (path === null || path === base || nested.some((rel) => isWithin(path, rel))) {
        continue;
      }
      const status = entryStatus(e);
      if (status === null) {
        continue;
      }
      if (e.path.endsWith('/') && status.tone === 'untracked') {
        untrackedDirs.add(path);
      }
      const prev = own.get(path);
      if (!prev || RANK[status.tone] > RANK[prev.tone]) {
        own.set(path, status);
      }
    }
  }
  // 안에 변경이 있는 디렉터리: 가까운 조상부터 올라가다 이미 표시한 디렉터리를 만나면 멈춘다 (그 위는 표시돼 있다)
  const inside = new Set<string>();
  for (const path of own.keys()) {
    for (const dir of ancestorDirs(path).reverse()) {
      if (dir === '' || inside.has(dir)) {
        break;
      }
      inside.add(dir);
    }
  }
  // 색인을 만들 때 지금 언어의 문구로 한 번 만든다: 안에 변경이 있는 디렉터리, 통째로 untracked 인 디렉터리의 아래 항목
  const t = S.project.fileStatus;
  const insideMark: RowStatus = { tone: 'modified', letter: null, title: t.inside };
  const untrackedMark = mark('untracked', '?', t.untracked);
  let changed: ChangedPath[] | null = null;
  return {
    changed() {
      changed ??= [...own.keys()].map((path) => ({ path, dir: untrackedDirs.has(path) }));
      return changed;
    },
    get(path) {
      const found = own.get(path);
      if (found) {
        return found;
      }
      if (untrackedDirs.size > 0 && ancestorDirs(path).some((dir) => untrackedDirs.has(dir))) {
        return untrackedMark;
      }
      return inside.has(path) ? insideMark : null;
    },
  };
}
