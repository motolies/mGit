// Project 트리의 보기 거르기 (R1). 이름 필터와 "변경된 파일만" 에 맞은 항목과 그 상위 폴더만 남긴 화면 행을 만든다.
//
// - 이름 필터: 검색어를 공백으로 나눈 낱말이 모두 항목 이름(마지막 경로 조각) 안에 이어서 들어 있어야 맞는다 (대소문자
//   무시, 낱말 순서 무관). 브랜치 칸 검색과 같은 "부분 글자열" 규칙이다 — ⌘P 의 띄엄띄엄 맞추기(`fuzzy.ts`)는 순위로
//   엉뚱한 후보를 뒤로 미루지만, 트리는 맞은 것을 모두 순위 없이 보이므로 띄엄띄엄 맞추면 엉뚱한 항목이 너무 많이 남는다.
//   낱말 나누기(한글 조합 중 끝 자모 떼기)와 대소문자 접기는 ⌘P 의 것을 그대로 쓴다.
// - 트리는 펼친 폴더만 읽어 두므로 이름 필터는 읽어 둔 항목에 ⌘P 의 파일 목록(`file-list.ts` — 무시 규칙에 걸린 것은
//   빠지고 추적 파일은 드는 전체 파일 경로)과 그 경로들의 폴더를 더해 찾는다. 읽어 둔 항목은 종류·크기·날짜를 알고, 목록에만
//   있는 것은 파일(또는 그 상위 폴더)로 본다.
// - "변경된 파일만": 상태 문자가 붙는 경로(`StatusLookup.changed`)가 후보다. 이름 필터와 함께 켜면 둘 다 맞아야 한다.
// - 거른 트리의 폴더는 늘 펼쳐 보이고 접지 않는다. 맞은 폴더라도 그 안에 맞은 항목이 없으면 자식 없이 보인다.
// - 형제 순서는 코어 나열과 같다 (디렉터리 먼저 → 소문자 이름 → 원래 이름, `SortKey`). 경로는 탭 공간의 상대 경로라
//   그룹 탭도 `별칭/…` 그대로다.

import type { FsEntry, FsEntryKind } from '@mgit/ipc';
import type { DirMap } from '../../store/file-tree';
import { ancestorDirs, baseName, childPath, parentDir } from '../../store/fs-path';
import { foldCase, queryTokens } from '../search/fuzzy';
import type { ChangedPath } from './file-status';
import type { EntryRow, ProjectTreeRow } from './project-tree-model';

/** 거른 트리에 보이는 맞은 항목 수 상한 (넘으면 앞의 것만 보이고 안내한다) */
export const FILTER_HIT_LIMIT = 5_000;

/** 이름 필터의 낱말: 대소문자를 접은 글자들. 한글 조합 중 끝에 홀로 선 자모는 뺀다 (⌘P 와 같다) */
export function filterTokens(query: string): string[] {
  return queryTokens(query).map(foldCase);
}

/**
 * 접은 이름이 낱말을 모두 이어서 담는지. 담으면 강조할 글자 위치(낱말마다 처음 나온 자리, 오름차순), 아니면 null.
 * 낱말이 없으면 빈 위치다
 */
export function matchName(foldedName: string, tokens: readonly string[]): number[] | null {
  if (tokens.length === 0) return [];
  const marked = new Set<number>();
  for (const token of tokens) {
    const at = foldedName.indexOf(token);
    if (at < 0) return null;
    for (let i = 0; i < token.length; i++) marked.add(at + i);
  }
  return [...marked].sort((a, b) => a - b);
}

/** 거른 트리에 놓을 항목 하나 */
interface FilterNode {
  path: string;
  kind: FsEntryKind;
  openable: boolean;
  size: number | null;
  mtimeMs: number | null;
}

/** 거르는 재료 */
export interface FilterSources {
  /** 트리가 읽어 둔 디렉터리 나열 */
  dirs: DirMap;
  /** 전체 파일 경로 (빠른 열기 목록). 아직 없거나 쓰지 않으면 빈 목록 */
  files: readonly string[];
  /** "변경된 파일만" 이면 상태 문자가 붙는 경로들, 아니면 null */
  changed: readonly ChangedPath[] | null;
}

/** 거른 결과 */
export interface FilteredTree {
  /** 화면 행 (루트 행 + 맞은 항목과 그 상위 폴더, 모두 펼침) */
  rows: ProjectTreeRow[];
  /** 맞은 항목의 id(경로) */
  hits: ReadonlySet<string>;
  /** 행 id → 이름에서 강조할 글자 위치 (이름 필터가 있을 때만) */
  marks: ReadonlyMap<string, readonly number[]>;
  /** 상한(`FILTER_HIT_LIMIT`)에 걸려 맞은 항목 일부만 보인다 */
  limited: boolean;
}

/** 읽은 목록마다의 이름 → 항목 색인 */
const ENTRY_INDEX = new WeakMap<readonly FsEntry[], Map<string, FsEntry>>();
/** 읽은 목록마다의 접은 이름들 (항목 순서와 같다) */
const FOLDED_ENTRIES = new WeakMap<readonly FsEntry[], string[]>();

/** 목록의 이름 → 항목 색인을 한 번 만들어 둔다 */
function entryIndex(entries: readonly FsEntry[]): Map<string, FsEntry> {
  let index = ENTRY_INDEX.get(entries);
  if (!index) {
    index = new Map(entries.map((e) => [e.name, e]));
    ENTRY_INDEX.set(entries, index);
  }
  return index;
}

/** 목록의 접은 이름들을 한 번 만들어 둔다 */
function foldedEntries(entries: readonly FsEntry[]): string[] {
  let folded = FOLDED_ENTRIES.get(entries);
  if (!folded) {
    folded = entries.map((e) => foldCase(e.name));
    FOLDED_ENTRIES.set(entries, folded);
  }
  return folded;
}

/** 경로의 읽어 둔 항목 (부모를 읽어 두었고 그 이름이 있으면). 없으면 undefined */
function loadedEntry(dirs: DirMap, path: string): FsEntry | undefined {
  const parent = parentDir(path);
  const load = parent === null ? undefined : dirs[parent]?.load;
  return load?.state === 'listed' ? entryIndex(load.entries).get(baseName(path)) : undefined;
}

/** 경로의 항목: 읽어 둔 것이 있으면 그 종류·크기·날짜, 없으면 `kind` 로 본다 (크기·날짜는 모른다) */
function nodeAt(dirs: DirMap, path: string, kind: 'file' | 'dir'): FilterNode {
  const entry = loadedEntry(dirs, path);
  if (entry) {
    return {
      path,
      kind: entry.kind,
      openable: entry.kind === 'file' && entry.openable,
      size: entry.size ?? null,
      mtimeMs: entry.mtimeMs ?? null,
    };
  }
  return { path, kind, openable: kind === 'file', size: null, mtimeMs: null };
}

/** 파일 목록에서 찾을 후보: 폴더 먼저(맞은 폴더가 상한에 밀리지 않게), 그다음 파일. 이름은 접어 둔다 */
interface ListIndex {
  paths: string[];
  folded: string[];
  dir: boolean[];
}

/** 파일 목록마다 후보 색인 (목록은 표지가 바뀔 때만 새 배열이다) */
const LIST_INDEX = new WeakMap<readonly string[], ListIndex>();

/** 파일 목록의 후보 색인을 한 번 만든다: 파일들의 상위 폴더(루트 제외)와 파일 */
function listIndex(files: readonly string[]): ListIndex {
  let index = LIST_INDEX.get(files);
  if (index) return index;
  const dirs = new Set<string>();
  for (const path of files) {
    // 가까운 부모부터 올라가다 이미 본 폴더를 만나면 그 위도 이미 들어 있다
    let dir = parentDir(path);
    while (dir !== null && dir !== '' && !dirs.has(dir)) {
      dirs.add(dir);
      dir = parentDir(dir);
    }
  }
  const paths = [...dirs, ...files];
  index = {
    paths,
    folded: paths.map((path) => foldCase(baseName(path))),
    dir: paths.map((_, i) => i < dirs.size),
  };
  LIST_INDEX.set(files, index);
  return index;
}

/** 형제 순서 (코어 `SortKey`): 디렉터리 먼저 → 소문자 이름 → 원래 이름 */
function compareNodes(a: { name: string; dir: boolean }, b: { name: string; dir: boolean }) {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  const la = a.name.toLowerCase();
  const lb = b.name.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * 거른 트리를 만든다. `tokens` 는 `filterTokens` 의 낱말(없으면 이름으로 거르지 않는다). 맞은 항목이 `limit` 를 넘으면
 * 앞의 것만 넣는다 — 읽어 둔 항목, 목록의 폴더, 목록의 파일 순서다
 */
export function filterProjectTree(
  sources: FilterSources,
  tokens: readonly string[],
  limit = FILTER_HIT_LIMIT,
): FilteredTree {
  const { dirs } = sources;
  const hits = new Map<string, FilterNode>();
  const marks = new Map<string, readonly number[]>();
  let limited = false;
  /** 후보 하나를 맞춰 넣는다. 상한에 걸리면 false (그만 찾는다) */
  const offer = (path: string, folded: string, make: () => FilterNode): boolean => {
    if (hits.has(path)) return true;
    const positions = matchName(folded, tokens);
    if (positions === null) return true;
    if (hits.size >= limit) {
      limited = true;
      return false;
    }
    hits.set(path, make());
    if (positions.length > 0) marks.set(path, positions);
    return true;
  };
  if (sources.changed) {
    for (const c of sources.changed) {
      const kind = c.dir ? 'dir' : 'file';
      if (!offer(c.path, foldCase(baseName(c.path)), () => nodeAt(dirs, c.path, kind))) break;
    }
  } else {
    scan: for (const [dir, state] of Object.entries(dirs)) {
      if (state.load.state !== 'listed') continue;
      const { entries } = state.load;
      const folded = foldedEntries(entries);
      for (const [i, entry] of entries.entries()) {
        const path = childPath(dir, entry.name);
        if (!offer(path, folded[i] ?? '', () => nodeAt(dirs, path, 'file'))) break scan;
      }
    }
    if (!limited && sources.files.length > 0) {
      const list = listIndex(sources.files);
      for (const [i, path] of list.paths.entries()) {
        const kind = list.dir[i] ? 'dir' : 'file';
        if (!offer(path, list.folded[i] ?? '', () => nodeAt(dirs, path, kind))) break;
      }
    }
  }
  return { rows: treeRows(dirs, hits), hits: new Set(hits.keys()), marks, limited };
}

/** 맞은 항목과 그 상위 폴더로 화면 행을 만든다. 자식이 있는 항목은 폴더로 보고 펼친다 */
function treeRows(dirs: DirMap, hits: ReadonlyMap<string, FilterNode>): ProjectTreeRow[] {
  const nodes = new Map(hits);
  for (const path of hits.keys()) {
    for (const dir of ancestorDirs(path)) {
      if (dir !== '' && !nodes.has(dir)) nodes.set(dir, nodeAt(dirs, dir, 'dir'));
    }
  }
  const children = new Map<string, FilterNode[]>();
  for (const node of nodes.values()) {
    const parent = parentDir(node.path) ?? '';
    const list = children.get(parent);
    if (list) list.push(node);
    else children.set(parent, [node]);
  }
  /** 폴더로 볼 항목인지 (자식이 있으면 폴더다) */
  const isDir = (node: FilterNode) => node.kind === 'dir' || children.has(node.path);
  const rows: ProjectTreeRow[] = [
    {
      kind: 'root',
      id: '',
      path: '',
      expanded: true,
      depth: 0,
      parentId: null,
      setSize: 1,
      posInSet: 1,
    },
  ];
  /** 그 폴더의 자식 행을 놓고, 자식이 있는 폴더는 그 자리에 이어 붙인다 */
  const visit = (dir: string, depth: number) => {
    const list = (children.get(dir) ?? [])
      .map((node) => ({ node, name: baseName(node.path), dir: isDir(node) }))
      .sort(compareNodes);
    for (const [index, { node, name, dir: folder }] of list.entries()) {
      const open = children.has(node.path);
      const row: EntryRow = {
        kind: 'entry',
        id: node.path,
        path: node.path,
        name,
        entryKind: folder ? 'dir' : node.kind,
        openable: !folder && node.openable,
        expandable: open,
        expanded: open,
        size: node.size,
        mtimeMs: node.mtimeMs,
        depth,
        parentId: dir,
        setSize: list.length,
        posInSet: index + 1,
      };
      rows.push(row);
      if (open) visit(node.path, depth + 1);
    }
  };
  visit('', 1);
  return rows;
}
