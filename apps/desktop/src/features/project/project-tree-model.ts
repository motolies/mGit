// 프로젝트 트리의 화면 행 (W11, PT-01·03·09). 디렉터리별 나열 상태와 펼침 기록을 받아, 가상 스크롤이 그릴
// 평탄한 행 목록을 만든다. 화면에 없는 행은 DOM 에 없으므로 행마다 단계·형제 수·형제 중 순번을 싣는다
// (`aria-level`·`aria-setsize`·`aria-posinset`).

import type { FsEntryKind } from '@mgit/ipc';
import { type DirMap, type ExpandedSet, FS_LIST_MAX, noteRowId } from '../../store/file-tree';
import { childPath } from '../../store/fs-path';

/** 모든 행에 있는 것 */
interface RowBase {
  /** 행 id = 선택 id (항목은 상대 경로, 루트는 '', 안내 줄은 `noteRowId`) */
  id: string;
  /** 들여쓰기 단계 (루트 0) */
  depth: number;
  /** 부모 행의 id. 루트는 null */
  parentId: string | null;
  /** 같은 부모 아래 행 수와 그중 몇 번째인지 (1부터) */
  setSize: number;
  posInSet: number;
}

/** 루트 행 (폴더 또는 작업 트리 자신) */
export interface RootRow extends RowBase {
  kind: 'root';
  path: '';
  expanded: boolean;
}

/** 디렉터리 항목 하나 */
export interface EntryRow extends RowBase {
  kind: 'entry';
  /** 루트 기준 상대 경로 */
  path: string;
  name: string;
  entryKind: FsEntryKind;
  /** 파일 보기로 열 수 있는지 (정규 파일이고 이름이 너무 길지 않음) */
  openable: boolean;
  /** 디렉터리라 펼칠 수 있는지 (링크·특수 파일은 펼치지 않는다) */
  expandable: boolean;
  expanded: boolean;
  /** 정규 파일의 크기(바이트)와 수정 시각(유닉스 밀리초) (PT-10). 모르면 null */
  size: number | null;
  mtimeMs: number | null;
}

/** 디렉터리 아래 상태 줄 (PT-09) */
export interface StatusRow extends RowBase {
  kind: 'status';
  dir: string;
  status: 'loading' | 'empty' | 'missing' | 'denied' | 'error';
  /** 오류 문구 (status 가 error 일 때) */
  error: string | null;
}

/** 잘린 디렉터리의 마지막 줄: "… N개 더 보기" 또는 더 볼 수 없다는 안내 (PT-03) */
export interface MoreRow extends RowBase {
  kind: 'more';
  dir: string;
  /** 보이는 항목 수 / 전체 항목 수 */
  shown: number;
  total: number;
  /** 누르면 더 보일 항목 수. 0 이면 상한(`FS_LIST_MAX`)에 걸려 더 볼 수 없다 */
  next: number;
  /** 더 읽는 중 */
  loading: boolean;
}

/** 이름이 UTF-8 이 아니어서 빠진 항목의 안내 줄 */
export interface NonUtf8Row extends RowBase {
  kind: 'nonUtf8';
  dir: string;
  count: number;
}

export type ProjectTreeRow = RootRow | EntryRow | StatusRow | MoreRow | NonUtf8Row;

/** 디렉터리 하나의 자식 행을 만든다. 펼친 하위 디렉터리는 그 자리에 이어 붙인다 */
function pushChildren(
  out: ProjectTreeRow[],
  dirs: DirMap,
  expanded: ExpandedSet,
  dir: string,
  depth: number,
): void {
  const state = dirs[dir];
  const load = state?.load;
  const parentId = dir;
  const status = (kind: StatusRow['status'], error: string | null = null) => {
    out.push({
      kind: 'status',
      id: noteRowId('status', dir),
      dir,
      status: kind,
      error,
      depth,
      parentId,
      setSize: 1,
      posInSet: 1,
    });
  };
  if (load === undefined || load.state === 'loading') {
    status('loading');
    return;
  }
  if (load.state !== 'listed') {
    status(load.state, load.state === 'error' ? load.error : null);
    return;
  }
  const notes = (load.nonUtf8Names > 0 ? 1 : 0) + (load.truncated ? 1 : 0);
  if (load.entries.length === 0 && notes === 0) {
    status('empty');
    return;
  }
  const setSize = load.entries.length + notes;
  load.entries.forEach((entry, index) => {
    const path = childPath(dir, entry.name);
    const expandable = entry.kind === 'dir';
    const open = expandable && expanded[path] === true;
    out.push({
      kind: 'entry',
      id: path,
      path,
      name: entry.name,
      entryKind: entry.kind,
      openable: entry.kind === 'file' && entry.openable,
      expandable,
      expanded: open,
      size: entry.size ?? null,
      mtimeMs: entry.mtimeMs ?? null,
      depth,
      parentId,
      setSize,
      posInSet: index + 1,
    });
    if (open) {
      pushChildren(out, dirs, expanded, path, depth + 1);
    }
  });
  let pos = load.entries.length;
  if (load.nonUtf8Names > 0) {
    pos += 1;
    out.push({
      kind: 'nonUtf8',
      id: noteRowId('nonUtf8', dir),
      dir,
      count: load.nonUtf8Names,
      depth,
      parentId,
      setSize,
      posInSet: pos,
    });
  }
  if (load.truncated) {
    pos += 1;
    out.push({
      kind: 'more',
      id: noteRowId('more', dir),
      dir,
      shown: load.entries.length,
      total: load.total,
      next: Math.max(0, Math.min(load.total, FS_LIST_MAX) - load.entries.length),
      loading: state?.pending === true,
      depth,
      parentId,
      setSize,
      posInSet: pos,
    });
  }
}

/**
 * 펼친 트리를 화면 행 목록으로 평탄화한다 (PT-03). 맨 위는 루트 행이고, 루트가 펼쳐져 있으면 그 아래에 나열
 * 순서 그대로(디렉터리 먼저, 대소문자 무시 이름순 — 코어가 정한 순서) 항목을 놓는다. 디렉터리를 아직 못 읽었으면
 * "읽는 중" 한 줄, 읽지 못했으면 상태 한 줄, 비었으면 "비어 있음" 한 줄을 놓는다
 */
export function flattenProjectTree(dirs: DirMap, expanded: ExpandedSet): ProjectTreeRow[] {
  const rootOpen = expanded[''] === true;
  const out: ProjectTreeRow[] = [
    {
      kind: 'root',
      id: '',
      path: '',
      expanded: rootOpen,
      depth: 0,
      parentId: null,
      setSize: 1,
      posInSet: 1,
    },
  ];
  if (rootOpen) {
    pushChildren(out, dirs, expanded, '', 1);
  }
  return out;
}
