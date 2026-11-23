// 프로젝트 트리의 디렉터리 나열 상태 (W11, PT-03·08·09). 폴더 세션과 저장소 세션이 같은 파일 API 를 쓰므로
// 어느 세션인지 모르고 "무엇으로 묻는지(source)"만 받는다 — 폴더 스토어가 지금 하나를 만들고, 저장소 탭이
// 같은 틀로 옮겨 오면(W21) 세션 스토어가 똑같이 하나를 만든다.
//
// - 디렉터리는 펼칠 때 그 디렉터리만 읽는다. 읽어 둔 것은 접었다 펴도 다시 읽지 않는다.
// - 디렉터리마다 차례(seq)를 두어 늦게 온 옛 응답을 버린다.
// - 다시 읽기(수동·창 포커스·재스캔·일괄 작업 뒤)는 지금 보이는 펼친 디렉터리만 다시 나열하고, 그동안 기존
//   항목을 그대로 보인다. 숨은(조상이 접힌) 디렉터리의 읽어 둔 결과는 낡았으므로 버린다.
// - 요청은 한꺼번에 `LIST_CONCURRENCY` 건까지만 나간다.
// - 결과가 바뀔 때마다 사라진 디렉터리의 펼침 기록을 지우고, 선택이 사라졌으면 가까운 조상으로 옮긴다.
// - 선택은 여러 행이다 (W12, PT-07): 고른 행 집합(`selection`) + 기준 행(`selected`, 마지막으로 고른 행 —
//   키보드 포커스·활성 저장소) + 범위의 시작 행(`anchor`, ⇧). 무엇이 "저장소" 인지는 이 스토어가 모른다 —
//   저장소 탭(W21)도 같은 스토어를 쓴다.

import type { FsDirListing, FsEntry, FsEntryKind, FsFile } from '@mgit/ipc';
import { createStore, type StoreApi } from 'zustand';
import { describeError } from './errors';
import { ancestorDirs, baseName, childPath, isWithin, parentDir } from './fs-path';

/** 한 디렉터리에서 볼 수 있는 항목 수 상한 (코어 `FS_LIST_MAX_LIMIT`) */
export const FS_LIST_MAX = 50_000;
/** 동시에 보내는 나열 요청 수 */
export const LIST_CONCURRENCY = 4;

/** 디렉터리 하나를 읽은 결과 */
export type DirLoad =
  | { state: 'loading' }
  | {
      state: 'listed';
      entries: FsEntry[];
      /** 자르기 전 항목 수 */
      total: number;
      truncated: boolean;
      /** 이름이 UTF-8 이 아니어서 빠진 항목 수 */
      nonUtf8Names: number;
    }
  | { state: 'missing' }
  | { state: 'denied' }
  | { state: 'error'; error: string };

/** 디렉터리 하나의 상태 */
export interface DirState {
  load: DirLoad;
  /** 요청한 항목 수 상한. null 이면 코어 기본값(2,000) */
  limit: number | null;
  /** 요청이 도는 중 (첫 읽기·더 보기·다시 읽기·다시 시도). 첫 읽기가 아니면 그동안 이전 결과를 그대로 보인다 */
  pending: boolean;
}

/** 디렉터리 경로 → 상태 */
export type DirMap = Readonly<Record<string, DirState>>;
/** 펼친 디렉터리 (루트 '' 포함) */
export type ExpandedSet = Readonly<Record<string, true>>;
/** 고른 행들의 id (PT-07) */
export type SelectionSet = Readonly<Record<string, true>>;

/** 선택 상태 묶음: 고른 행 집합, 기준 행, 범위의 시작 행 */
export interface SelectionState {
  selection: SelectionSet;
  selected: string | null;
  anchor: string | null;
}

/** 무엇으로 묻는지. 경로는 루트 기준 상대 경로 (루트 = '') */
export interface FileTreeSource {
  list(dir: string, limit: number | null): Promise<FsDirListing>;
  read(path: string): Promise<FsFile>;
}

// ── 안내 줄 id ────────────────────────────────────────────────────────────────────
// 트리에는 항목 말고도 디렉터리마다 안내 줄(읽는 중·비어 있음·없음·권한 없음·오류, "… N개 더 보기", 이름을
// 읽을 수 없는 항목)이 붙는다. 이 줄도 키보드로 고를 수 있으므로 선택 id 를 가진다. 경로에는 NUL 이 올 수 없어
// 항목 id(= 경로)와 겹치지 않는다

/** 안내 줄의 종류 */
export type NoteKind = 'status' | 'more' | 'nonUtf8';

/** 디렉터리 아래 안내 줄의 id */
export function noteRowId(kind: NoteKind, dir: string): string {
  return `\u0000${kind}:${dir}`;
}

/** 안내 줄 id 면 종류와 디렉터리, 항목 id 면 null */
export function parseNoteRowId(id: string): { kind: NoteKind; dir: string } | null {
  if (!id.startsWith('\u0000')) {
    return null;
  }
  const at = id.indexOf(':');
  const kind = id.slice(1, at);
  if (kind !== 'status' && kind !== 'more' && kind !== 'nonUtf8') {
    return null;
  }
  return { kind, dir: id.slice(at + 1) };
}

// ── 순수 함수 (테스트 대상) ──────────────────────────────────────────────────────────

/** 나열 응답을 디렉터리 상태로 */
export function listingLoad(listing: FsDirListing): DirLoad {
  switch (listing.kind) {
    case 'listed':
      return {
        state: 'listed',
        entries: listing.entries,
        total: listing.total,
        truncated: listing.truncated,
        nonUtf8Names: listing.nonUtf8Names,
      };
    case 'missing':
      return { state: 'missing' };
    case 'denied':
      return { state: 'denied' };
  }
}

/** 읽은 목록마다의 이름 → 종류 색인. 선택이 여러 행이면 같은 목록을 여러 번 찾으므로 목록 객체에 묶어 둔다 */
const ENTRY_INDEX = new WeakMap<readonly FsEntry[], Map<string, FsEntryKind>>();

/** 읽은 목록에 그 이름의 항목이 있는지. `dirOnly` 면 디렉터리 항목만 본다 */
function hasEntry(load: DirLoad | undefined, name: string, dirOnly: boolean): boolean {
  if (load?.state !== 'listed') {
    return false;
  }
  let index = ENTRY_INDEX.get(load.entries);
  if (!index) {
    index = new Map(load.entries.map((e) => [e.name, e.kind]));
    ENTRY_INDEX.set(load.entries, index);
  }
  const kind = index.get(name);
  return kind !== undefined && (!dirOnly || kind === 'dir');
}

/**
 * 지금 보이는 펼친 디렉터리들 (루트부터 깊이 우선): 루트가 펼쳐져 있으면 루트, 그리고 보이는 디렉터리의 읽은
 * 목록 안에서 펼침 기록이 있는 디렉터리. 아직 안 읽은 디렉터리도 들어간다 (그 아래는 모른다)
 */
export function visibleExpandedDirs(dirs: DirMap, expanded: ExpandedSet): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    out.push(dir);
    const load = dirs[dir]?.load;
    if (load?.state !== 'listed') {
      return;
    }
    for (const entry of load.entries) {
      const path = childPath(dir, entry.name);
      if (entry.kind === 'dir' && expanded[path]) {
        visit(path);
      }
    }
  };
  if (expanded['']) {
    visit('');
  }
  return out;
}

/**
 * 사라진 디렉터리의 기록을 지운다: 부모의 읽은 목록에 디렉터리로 없으면 그 디렉터리와 그 아래의 펼침 기록과
 * 읽어 둔 결과를 모두 지운다 (부모를 아직 안 읽었으면 판단하지 않는다). 지운 것이 없으면 받은 객체 그대로
 */
export function pruneVanished(
  dirs: DirMap,
  expanded: ExpandedSet,
): { dirs: DirMap; expanded: ExpandedSet; removed: string[] } {
  const gone = new Set<string>();
  for (const path of new Set([...Object.keys(dirs), ...Object.keys(expanded)])) {
    const parent = parentDir(path);
    if (parent === null) {
      continue;
    }
    const load = dirs[parent]?.load;
    if (load?.state === 'listed' && !hasEntry(load, baseName(path), true)) {
      gone.add(path);
    }
  }
  if (gone.size === 0) {
    return { dirs, expanded, removed: [] };
  }
  const vanished = (path: string) => [...gone].some((root) => isWithin(path, root));
  const removed = Object.keys(dirs).filter(vanished);
  return {
    dirs: Object.fromEntries(Object.entries(dirs).filter(([path]) => !vanished(path))),
    expanded: Object.fromEntries(Object.entries(expanded).filter(([path]) => !vanished(path))),
    removed,
  };
}

/** 안내 줄이 지금 상태에서 그려지는지 (`flattenProjectTree` 와 같은 조건) */
function noteExists(dirs: DirMap, kind: NoteKind, dir: string): boolean {
  const load = dirs[dir]?.load;
  switch (kind) {
    case 'status':
      return (
        load === undefined ||
        load.state !== 'listed' ||
        (load.entries.length === 0 && !load.truncated && load.nonUtf8Names === 0)
      );
    case 'more':
      return load?.state === 'listed' && load.truncated;
    case 'nonUtf8':
      return load?.state === 'listed' && load.nonUtf8Names > 0;
  }
}

/**
 * 결과가 바뀐 뒤의 선택 (PT-08): 선택한 항목이 사라졌으면 남아 있는 가장 가까운 조상으로 옮긴다. 조상의 목록을
 * 아직 안 읽었으면 그 아래는 판단하지 않고 둔다. 안내 줄은 그 줄이 사라졌으면 그 디렉터리로 옮긴다
 */
export function survivingSelection(dirs: DirMap, selected: string | null): string | null {
  if (selected === null) {
    return null;
  }
  const note = parseNoteRowId(selected);
  if (note) {
    return noteExists(dirs, note.kind, note.dir) ? selected : survivingSelection(dirs, note.dir);
  }
  if (selected === '') {
    return selected;
  }
  const chain = [...ancestorDirs(selected).slice(1), selected];
  for (const path of chain) {
    const parent = parentDir(path) ?? '';
    const load = dirs[parent]?.load;
    if (load?.state !== 'listed') {
      return selected;
    }
    if (!hasEntry(load, baseName(path), path !== selected)) {
      return parent;
    }
  }
  return selected;
}

/** 그 행 하나만 고른 집합. null 이면 빈 집합 */
export function onlySelection(id: string | null): SelectionSet {
  return id === null ? {} : { [id]: true };
}

/**
 * 범위 선택 (⇧, PT-07): 보이는 행 순서(`order`)에서 `from` 부터 `to` 까지의 행 id. 사이의 안내 줄(읽는 중·더
 * 보기 등)은 넣지 않는다 — 끝 행이 안내 줄이면 그 줄만은 넣는다. `from` 이 지금 보이지 않으면 `to` 하나
 */
export function rangeSelection(order: readonly string[], from: string, to: string): string[] {
  const end = order.indexOf(to);
  const start = order.indexOf(from);
  if (end < 0) {
    return [to];
  }
  if (start < 0) {
    return [to];
  }
  const [lo, hi] = start <= end ? [start, end] : [end, start];
  return order.slice(lo, hi + 1).filter((id) => id === to || parseNoteRowId(id) === null);
}

/**
 * 결과가 바뀐 뒤의 선택 (PT-07·08): 기준 행·범위 시작 행은 `survivingSelection` 대로 남아 있는 가장 가까운
 * 조상으로 옮기고, 기준 행이 고른 행이었으면 옮긴 자리도 고른다. 그 밖의 고른 행 중 사라진 것은 뺀다.
 * 바뀐 것이 없으면 받은 객체 그대로
 */
export function survivingSelectionState(dirs: DirMap, cur: SelectionState): SelectionState {
  const selected = survivingSelection(dirs, cur.selected);
  const anchor = survivingSelection(dirs, cur.anchor);
  const gone = Object.keys(cur.selection).filter((id) => survivingSelection(dirs, id) !== id);
  const leadMoved =
    selected !== null &&
    cur.selected !== null &&
    selected !== cur.selected &&
    cur.selection[cur.selected] === true;
  let selection = cur.selection;
  if (gone.length > 0 || leadMoved) {
    const next: Record<string, true> = { ...cur.selection };
    for (const id of gone) {
      delete next[id];
    }
    if (leadMoved && selected !== null) {
      next[selected] = true;
    }
    selection = next;
  }
  if (selection === cur.selection && selected === cur.selected && anchor === cur.anchor) {
    return cur;
  }
  return { selection, selected, anchor };
}

/**
 * 디렉터리를 접은 뒤의 선택: 그 안(자기 안내 줄 포함)에 숨는 고른 행은 빼고 대신 접은 디렉터리를 고른다.
 * 기준 행·범위 시작 행이 그 안에 있었으면 접은 디렉터리로 옮긴다. 바뀐 것이 없으면 받은 객체 그대로
 */
export function collapsedSelectionState(cur: SelectionState, path: string): SelectionState {
  /** 접은 디렉터리 안에 숨는 행인지 (접은 디렉터리 자신은 아니다) */
  const hidden = (id: string | null): boolean => {
    if (id === null || id === path) {
      return false;
    }
    return isWithin(parseNoteRowId(id)?.dir ?? id, path);
  };
  const inside = Object.keys(cur.selection).filter(hidden);
  const leadHidden = hidden(cur.selected);
  const anchorHidden = hidden(cur.anchor);
  if (inside.length === 0 && !leadHidden && !anchorHidden) {
    return cur;
  }
  let selection = cur.selection;
  if (inside.length > 0) {
    const next: Record<string, true> = { ...cur.selection };
    for (const id of inside) {
      delete next[id];
    }
    next[path] = true;
    selection = next;
  }
  return {
    selection,
    selected: leadHidden ? path : cur.selected,
    anchor: anchorHidden ? path : cur.anchor,
  };
}

// ── 스토어 ─────────────────────────────────────────────────────────────────────────

/** 프로젝트 트리 상태 */
export interface FileTreeState extends SelectionState {
  dirs: DirMap;
  expanded: ExpandedSet;
  /** 고른 행들의 id (항목 = 상대 경로, 루트 = '', 안내 줄 = `noteRowId`) */
  selection: SelectionSet;
  /**
   * 기준 행: 마지막으로 고른 행의 id (키보드 포커스, 활성 저장소). 없으면 null. ⌘클릭으로 뺀 행이면 고른 행
   * 집합에는 없을 수 있다
   */
  selected: string | null;
  /** 범위 선택(⇧)의 시작 행. 그냥 클릭·⌘클릭이 정하고 ⇧ 는 바꾸지 않는다 */
  anchor: string | null;
  /** 디스크를 다시 본 차례. 다시 읽기마다 오른다 — 열린 파일 보기도 이 값이 바뀌면 다시 읽는다 */
  epoch: number;
  /** "트리에서 찾기"(◎)로 고른 차례. 화면은 이 값이 바뀌면 고른 행으로 스크롤한다 */
  revealSeq: number;

  /** 루트와, 보이는 펼친 디렉터리 중 아직 안 읽은 것을 읽는다 (트리가 처음 보일 때) */
  open(): void;
  /** 펼침을 뒤집는다 */
  toggle(path: string): void;
  /** 펼치거나 접는다. 펼치면 아직 안 읽은 디렉터리를 읽고, 접으면 그 안의 선택을 그 디렉터리로 옮긴다 */
  setExpanded(path: string, expanded: boolean): void;
  /** 그 행 하나만 고른다 (그냥 클릭·화살표). null 이면 선택을 비운다 */
  select(id: string | null): void;
  /** 그 행을 선택에 더하거나 뺀다 (⌘클릭). 기준 행·범위 시작 행이 그 행이 된다 */
  toggleInSelection(id: string): void;
  /** 범위 시작 행부터 그 행까지 고른다 (⇧클릭·⇧↑↓). `order` 는 지금 보이는 행 순서 */
  selectRange(id: string, order: readonly string[]): void;
  /** 그 행들을 선택에 넣거나 뺀다. 다른 선택과 기준 행은 그대로다 (개요 탭의 체크박스) */
  markSelected(ids: readonly string[], on: boolean): void;
  /** 잘린 디렉터리의 상한을 올려 다시 읽는다 ("… N개 더 보기", 최대 `FS_LIST_MAX`) */
  loadMore(dir: string): void;
  /** 그 디렉터리를 다시 읽는다 (오류 뒤 "다시 시도") */
  retry(dir: string): void;
  /**
   * 보이는 펼친 디렉터리만 다시 나열한다 (PT-08). 이미 도는 중이면 끝난 뒤 한 번 더 돈다(그사이의 변경을 놓치지
   * 않게). 돌려준 약속은 모두 끝났을 때 풀린다
   */
  reload(): Promise<void>;
  /** 그 경로의 조상을 차례로 펼치고 그 행을 고른다 (트리에서 찾기). 없으면 남아 있는 가장 가까운 조상을 고른다 */
  reveal(path: string): Promise<void>;
  /** 파일 하나를 읽는다 (파일 보기 탭) */
  readFile(path: string): Promise<FsFile>;
  /** 트리의 스크롤 위치를 기억한다 (화면이 다시 붙을 때 돌아갈 자리). 다시 그릴 값이 아니라 구독 상태 밖에 둔다 */
  rememberScroll(top: number): void;
  scrollTop(): number;
  /** 이후 응답을 모두 버린다 */
  dispose(): void;
}

export type FileTreeStore = StoreApi<FileTreeState>;

/** 첫 읽기 중 */
const LOADING: DirLoad = { state: 'loading' };

/** 프로젝트 트리 상태를 만든다. 루트는 펼친 채 시작하고, 읽기는 `open` 이 시작한다 */
export function createFileTree(source: FileTreeSource): FileTreeStore {
  // 디렉터리별 요청 차례. 새 요청·기록 삭제마다 올려 옛 응답을 버린다
  const seqs = new Map<string, number>();
  // 디렉터리별 마지막 요청 (트리에서 찾기가 읽기를 기다릴 때)
  const inflight = new Map<string, Promise<void>>();
  // 동시 요청 수 제한
  let active = 0;
  const waiting: (() => void)[] = [];
  let reloading: Promise<void> | null = null;
  let reloadAgain = false;
  let scroll = 0;
  let disposed = false;

  /** 동시에 `LIST_CONCURRENCY` 건까지만 돌린다 */
  const limited = <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            waiting.shift()?.();
          });
      };
      if (active < LIST_CONCURRENCY) {
        run();
      } else {
        waiting.push(run);
      }
    });

  return createStore<FileTreeState>()((set, get) => {
    /**
     * 디렉터리 하나의 결과를 싣고, 사라진 디렉터리를 정리하고, 선택을 맞춘다. 더 보기로 늘린 뒤에 "… 더 보기"
     * 줄을 고르고 있었으면 새로 보인 첫 항목을 고른다 (그 줄이 있던 자리)
     */
    const settle = (dir: string, state: DirState) => {
      const prev = get();
      const before = prev.dirs[dir]?.load;
      const pruned = pruneVanished({ ...prev.dirs, [dir]: state }, prev.expanded);
      for (const path of pruned.removed) {
        seqs.set(path, (seqs.get(path) ?? 0) + 1);
      }
      let picked: SelectionState = prev;
      const more = noteRowId('more', dir);
      const onMore = prev.selected === more || prev.anchor === more || prev.selection[more];
      if (onMore && before?.state === 'listed' && state.load.state === 'listed') {
        const first = state.load.entries[before.entries.length];
        if (first) {
          // "… 더 보기" 줄이 있던 자리에 새로 보인 첫 항목이 온다
          const id = childPath(dir, first.name);
          const swap = (x: string | null) => (x === more ? id : x);
          const selection: Record<string, true> = { ...prev.selection };
          if (selection[more]) {
            delete selection[more];
            selection[id] = true;
          }
          picked = { selection, selected: swap(prev.selected), anchor: swap(prev.anchor) };
        }
      }
      const kept = survivingSelectionState(pruned.dirs, picked);
      set({
        dirs: pruned.dirs,
        expanded: pruned.expanded,
        selection: kept.selection,
        selected: kept.selected,
        anchor: kept.anchor,
      });
      // 이 결과로 보이게 된 펼친 하위 디렉터리(펼침을 기억해 둔 것)를 읽는다
      loadMissing();
    };

    /** 그 디렉터리를 읽는다. 그사이 차례가 지났으면 요청을 건너뛰거나 응답을 버린다 */
    const request = (dir: string, limit: number | null): Promise<void> => {
      if (disposed) {
        return Promise.resolve();
      }
      const seq = (seqs.get(dir) ?? 0) + 1;
      seqs.set(dir, seq);
      const prev = get().dirs[dir];
      set({
        dirs: { ...get().dirs, [dir]: { load: prev?.load ?? LOADING, limit, pending: true } },
      });
      const current = () => !disposed && seqs.get(dir) === seq;
      const done = limited(() =>
        current() ? source.list(dir, limit) : Promise.resolve(null),
      ).then(
        (listing) => {
          if (listing !== null && current()) {
            settle(dir, { load: listingLoad(listing), limit, pending: false });
          }
        },
        (error: unknown) => {
          if (current()) {
            settle(dir, {
              load: { state: 'error', error: describeError(error) },
              limit,
              pending: false,
            });
          }
        },
      );
      inflight.set(dir, done);
      return done;
    };

    /** 보이는 펼친 디렉터리 중 아직 안 읽은 것을 읽는다 */
    const loadMissing = () => {
      const { dirs, expanded } = get();
      for (const dir of visibleExpandedDirs(dirs, expanded)) {
        if (!dirs[dir]) {
          void request(dir, null);
        }
      }
    };

    /** 한 번 다시 읽는다: 숨은 디렉터리의 결과는 버리고 보이는 펼친 디렉터리를 모두 다시 나열한다 */
    const reloadOnce = async () => {
      const { dirs, expanded, epoch } = get();
      const visible = visibleExpandedDirs(dirs, expanded);
      const shown = new Set(visible);
      for (const path of Object.keys(dirs)) {
        if (!shown.has(path)) {
          seqs.set(path, (seqs.get(path) ?? 0) + 1);
        }
      }
      set({
        epoch: epoch + 1,
        dirs: Object.fromEntries(Object.entries(dirs).filter(([path]) => shown.has(path))),
      });
      await Promise.all(visible.map((dir) => request(dir, get().dirs[dir]?.limit ?? null)));
      if (!disposed) {
        loadMissing();
      }
    };

    /** 그 행 하나만 고른 선택 상태 */
    const only = (id: string | null): SelectionState => ({
      selection: onlySelection(id),
      selected: id,
      anchor: id,
    });

    return {
      dirs: {},
      expanded: { '': true },
      selection: {},
      selected: null,
      anchor: null,
      epoch: 0,
      revealSeq: 0,

      open() {
        if (!disposed) {
          loadMissing();
        }
      },

      toggle(path) {
        get().setExpanded(path, !get().expanded[path]);
      },

      setExpanded(path, on) {
        const { expanded } = get();
        if (on) {
          if (!expanded[path]) {
            set({ expanded: { ...expanded, [path]: true } });
          }
          loadMissing();
          return;
        }
        if (!expanded[path]) {
          return;
        }
        const rest = { ...expanded };
        delete rest[path];
        // 접은 디렉터리 안에서 고르고 있었으면 그 디렉터리를 고른다 (선택 행이 숨지 않게)
        const prev = get();
        const next = collapsedSelectionState(prev, path);
        set({
          expanded: rest,
          ...(next === prev
            ? {}
            : { selection: next.selection, selected: next.selected, anchor: next.anchor }),
        });
      },

      select(id) {
        set(only(id));
      },

      toggleInSelection(id) {
        const selection: Record<string, true> = { ...get().selection };
        if (selection[id]) {
          delete selection[id];
        } else {
          selection[id] = true;
        }
        set({ selection, selected: id, anchor: id });
      },

      selectRange(id, order) {
        const { anchor, selected } = get();
        const from = anchor ?? selected ?? id;
        set({
          selection: Object.fromEntries(rangeSelection(order, from, id).map((x) => [x, true])),
          selected: id,
          anchor: from,
        });
      },

      markSelected(ids, on) {
        const prev = get().selection;
        const selection: Record<string, true> = { ...prev };
        for (const id of ids) {
          if (on) {
            selection[id] = true;
          } else {
            delete selection[id];
          }
        }
        const same =
          Object.keys(selection).length === Object.keys(prev).length &&
          Object.keys(selection).every((id) => prev[id]);
        if (!same) {
          set({ selection });
        }
      },

      loadMore(dir) {
        const load = get().dirs[dir]?.load;
        if (load?.state !== 'listed' || !load.truncated || load.entries.length >= FS_LIST_MAX) {
          return;
        }
        if (get().dirs[dir]?.pending) {
          return;
        }
        void request(dir, Math.min(load.total, FS_LIST_MAX));
      },

      retry(dir) {
        void request(dir, get().dirs[dir]?.limit ?? null);
      },

      reload() {
        if (disposed) {
          return Promise.resolve();
        }
        if (reloading) {
          reloadAgain = true;
          return reloading;
        }
        reloading = (async () => {
          do {
            reloadAgain = false;
            await reloadOnce();
          } while (reloadAgain && !disposed);
        })().finally(() => {
          reloading = null;
        });
        return reloading;
      },

      async reveal(path) {
        for (const dir of ancestorDirs(path)) {
          if (disposed) {
            return;
          }
          get().setExpanded(dir, true);
          const state = get().dirs[dir];
          if (!state || state.load.state === 'loading') {
            await (inflight.get(dir) ?? request(dir, null));
          }
          const next = path.slice(dir === '' ? 0 : dir.length + 1).split('/')[0] ?? '';
          const nextPath = childPath(dir, next);
          const isLast = nextPath === path;
          if (!hasEntry(get().dirs[dir]?.load, next, !isLast)) {
            set({ ...only(dir), revealSeq: get().revealSeq + 1 });
            return;
          }
        }
        set({ ...only(path), revealSeq: get().revealSeq + 1 });
      },

      readFile(path) {
        return source.read(path);
      },

      rememberScroll(top) {
        scroll = top;
      },

      scrollTop() {
        return scroll;
      },

      dispose() {
        // 줄 선 요청은 차례가 지난 것으로 보고 묻지 않은 채 끝난다
        disposed = true;
      },
    };
  });
}
