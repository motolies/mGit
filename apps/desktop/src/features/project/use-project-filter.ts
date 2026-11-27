// Project 트리 보기 거르기의 컨테이너 연결 (R1). 폴더 탭·그룹 탭(`FolderWorkspace`)과 저장소 탭(`RepoWorkspace`)이 같은
// 훅으로 거른 행과 거르기 줄의 상태를 얻는다. 거르기 상태는 탭의 파일 트리 스토어(`filter`)에 있어 탭을 오가거나 Commit 도구
// 창으로 바꿨다 와도 남고, 저장하지 않으므로 재시작하면 거르지 않은 트리로 돌아온다.
//
// 이름 필터가 켜지면 ⌘P 의 파일 목록 캐시(`fileListCache`)를 함께 쓴다 — 같은 표지(`filesStamp`)면 다시 받지 않고, 트리를
// 다시 읽은 뒤(epoch)에만 표지를 다시 본다. 목록을 받는 동안에는 읽어 둔 폴더에서 먼저 찾아 보인다.

import type { SessionId, WorkspaceFileList } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, useFileTree } from '../../store';
import { type DirMap, NO_PROJECT_FILTER, parseNoteRowId } from '../../store/file-tree';
import { fileListCache, filesStamp } from '../search/file-list';
import type { StatusLookup } from './file-status';
import { FILTER_HIT_LIMIT, filterProjectTree, filterTokens } from './project-filter';
import type { ProjectTreeRow } from './project-tree-model';

/** 거르기 줄이 보이고 다루는 상태 (`ManagedProjectTree` 의 `filter`) */
export interface ProjectFilterView {
  /** 이름 필터 칸의 글자 (입력 그대로) */
  query: string;
  changedOnly: boolean;
  /** 지금 행을 거르고 있는지 (이름 낱말이 있거나 변경된 파일만) — 폴더를 접고 펴지 않는다 */
  active: boolean;
  /** 맞은 항목의 id. 거르지 않으면 비어 있다 */
  hits: ReadonlySet<string>;
  /** 행 id → 이름에서 강조할 글자 위치 */
  marks: ReadonlyMap<string, readonly number[]>;
  /** 거르기 줄 아래 안내 한 줄 (읽는 중·맞는 것 없음·상한·일부만). 없으면 null */
  note: string | null;
  setQuery(query: string): void;
  setChangedOnly(on: boolean): void;
  /** 그 경로의 행이 거른 보기에 없으면 거르기를 모두 끈다 ("열린 파일을 트리에서 찾기" 가 그 행을 보이게) */
  showPath(path: string): void;
}

/** 파일 목록 요청 상태. 화면이 여러 탭에서 다시 쓰이므로 어느 세션 것인지 함께 든다 */
interface ListState {
  session: SessionId | null;
  list: WorkspaceFileList | null;
  loading: boolean;
  failed: boolean;
}

const NO_LIST: ListState = { session: null, list: null, loading: false, failed: false };
const NO_FILES: readonly string[] = [];
const NO_HITS: ReadonlySet<string> = new Set();
const NO_MARKS: ReadonlyMap<string, readonly number[]> = new Map();

/**
 * 탭의 Project 트리 행을 보기 거르기로 거른다. `rows` 는 거르지 않은 행, `dirs` 는 트리가 읽어 둔 나열, `statuses` 는 행
 * 상태 색인이다. 거르기를 끄면 그때 고른 행으로 트리를 펼쳐 스크롤한다 (선택은 그대로). 트리 스토어가 없으면 `filter` 가
 * 없고 행은 그대로다
 */
export function useProjectFilter({
  session,
  rows,
  dirs,
  statuses,
}: {
  session: SessionId | null;
  rows: readonly ProjectTreeRow[];
  dirs: DirMap | undefined;
  statuses: StatusLookup;
}): { rows: readonly ProjectTreeRow[]; filter: ProjectFilterView | undefined } {
  const tree = useFileTree((t) => ({
    filter: t.filter,
    setFilter: t.setFilter,
    selected: t.selected,
    reveal: t.reveal,
  }));
  const client = useAppStore((s) => s.client);
  const filter = tree?.filter ?? NO_PROJECT_FILTER;
  // 입력칸은 먼저 그리고 거르기는 뒤따라 계산한다 (목록이 크면 한 번에 수십 ms)
  const query = useDeferredValue(filter.query);
  const tokens = useMemo(() => filterTokens(query), [query]);
  const active = tokens.length > 0 || filter.changedOnly;
  const needList = session !== null && tokens.length > 0 && !filter.changedOnly;
  // 트리를 다시 읽은 신호(epoch)는 이름 필터가 파일 목록을 쓰는 동안에만 구독한다 — 필터가 꺼져 있어도 구독하면 창 포커스의
  // 배경 다시 읽기마다 이 훅을 쓰는 워크스페이스(Project 트리·편집기 공간)가 통째로 다시 그려졌다 (D-4)
  const epoch = useFileTree((t) => (needList ? t.epoch : 0)) ?? 0;
  const [listState, setListState] = useState<ListState>(NO_LIST);

  // 이름 필터가 켜져 있는 동안 파일 목록을 받아 둔다. 표지가 같으면 캐시를 그대로 쓴다
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch 는 표지를 다시 보라는 신호다 (트리를 다시 읽었다)
  useEffect(() => {
    if (!needList || session === null) return;
    let live = true;
    const loading = fileListCache.load(session, filesStamp(session), () =>
      client.workspaceFiles(session, `tree-filter-${session}-${Date.now()}`),
    );
    setListState({
      session,
      list: fileListCache.peek(session),
      loading: fileListCache.isLoading(session),
      failed: false,
    });
    loading.then(
      (list) => {
        if (live) setListState({ session, list, loading: false, failed: false });
      },
      () => {
        if (live)
          setListState({
            session,
            list: fileListCache.peek(session),
            loading: false,
            failed: true,
          });
      },
    );
    return () => {
      live = false;
    };
  }, [client, session, needList, epoch]);

  const own = listState.session === session ? listState : NO_LIST;
  const files = (needList && own.list?.files) || NO_FILES;
  const result = useMemo(
    () =>
      active
        ? filterProjectTree(
            {
              dirs: dirs ?? {},
              files,
              changed: filter.changedOnly ? statuses.changed() : null,
            },
            tokens,
          )
        : null,
    [active, dirs, files, filter.changedOnly, statuses, tokens],
  );

  // 거르기를 끄면 고른 행이 보이게 트리를 펼쳐 스크롤한다. 같은 탭에서 켜졌다 꺼진 때만이다 (탭을 바꾼 것은 아니다)
  const was = useRef<{ session: SessionId | null; active: boolean }>({ session, active });
  const reveal = tree?.reveal;
  const selected = tree?.selected ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 켜짐이 바뀔 때만 본다 (고른 행이 바뀔 때마다 펼치지 않는다)
  useEffect(() => {
    const prev = was.current;
    was.current = { session, active };
    if (prev.session === session && prev.active && !active && selected !== null && reveal) {
      if (parseNoteRowId(selected) === null) void reveal(selected, true);
    }
  }, [session, active]);

  const setFilter = tree?.setFilter;
  const view = useMemo((): ProjectFilterView | undefined => {
    if (!setFilter) return undefined;
    const partial = needList && !own.loading && (own.failed || !!own.list?.truncated);
    const loadingList = needList && own.loading;
    const t = S.project.filter;
    let note: string | null = null;
    if (result) {
      if (result.hits.size === 0) {
        note = loadingList
          ? t.loading
          : tokens.length === 0 && filter.changedOnly
            ? t.noChanges
            : t.noMatch;
      } else if (loadingList) {
        note = t.loading;
      } else if (result.limited) {
        note = t.limited(FILTER_HIT_LIMIT);
      } else if (partial) {
        note = t.partial;
      }
    }
    return {
      query: filter.query,
      changedOnly: filter.changedOnly,
      active,
      hits: result?.hits ?? NO_HITS,
      marks: result?.marks ?? NO_MARKS,
      note,
      setQuery: (next) => setFilter({ query: next }),
      setChangedOnly: (on) => setFilter({ changedOnly: on }),
      showPath: (path) => {
        if (result && !result.rows.some((row) => row.id === path)) setFilter(NO_PROJECT_FILTER);
      },
    };
  }, [setFilter, filter, active, result, needList, own, tokens]);

  return { rows: result?.rows ?? rows, filter: view };
}
