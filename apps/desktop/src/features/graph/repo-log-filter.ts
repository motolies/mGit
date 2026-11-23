// 저장소 탭 로그 필터 바의 순수 규칙 (LG-15, W26): 세션 상태를 공용 필터 바(`FilterBar`)의 props 로 바꾸는 변환과, 옛
// 그래프 머리줄·그래프 필터 바(W28 에서 지웠다)의 동작을 옮겨 온 것. 화면·스토어를 모른다.

import type { GraphLayoutPrefs, GraphQuery, GraphRevs, Module } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { DropdownItem } from '../../components/DropdownMenu';
import { DEFAULT_GRAPH_QUERY, type GraphViewPrefs, isDefaultGraphQuery } from '../../store';
import {
  type BranchTreeNode,
  LOCAL_REF_PREFIX,
  leafNodes,
  REMOTE_REF_PREFIX,
} from '../branches/branch-tree-model';
import type { BranchOption } from '../filter-bar/FilterBar';
import { HEAD_OPTION_ID } from '../filter-bar/filter-model';
import { timelineStatus } from '../folder/FolderLogFilter';

/**
 * 저장소 브랜치 트리의 잎 → branch 드롭다운 항목 (트리와 같은 목록·순서: 로컬 → 원격, 각각 현재 > 즐겨찾기 > 이름).
 * 항목 이름은 질의에 실리는 ref 이름(짧은 이름 — 원격은 `origin/main`)이다: 브랜치 트리 메뉴의 "이 branch 만 그래프에
 * 표시"가 거는 solo 와 같은 값이라 거기서 건 것이 드롭다운에 체크로 보인다. 원격 잎의 글자는 원격 그룹 아래라 원격 이름이
 * 없으므로 전체 이름에서 만든다
 */
export function repoBranchOptionsOf(nodes: readonly BranchTreeNode[]): BranchOption[] {
  return leafNodes(nodes).flatMap((node) => {
    if ((node.kind !== 'local' && node.kind !== 'remote') || !node.fullName) {
      return [];
    }
    const prefix = node.kind === 'local' ? LOCAL_REF_PREFIX : REMOTE_REF_PREFIX;
    const name = node.fullName.startsWith(prefix)
      ? node.fullName.slice(prefix.length)
      : node.fullName;
    return [
      {
        name,
        remote: node.kind === 'remote',
        current: node.current ?? false,
        title: node.fullName,
      },
    ];
  });
}

/**
 * "ref 이름 입력…" 대화상자의 처음 값 (옛 "ref 고르기…"의 자리, W26): 드롭다운에서 체크하던 초안을 쉼표로 잇는다. HEAD 는
 * 현재 branch 이름으로 바꾸고(분리 HEAD 면 뺀다), 초안이 비면 옛 규칙대로 현재 branch (없으면 빈 칸)
 */
export function customRefsInitial(draft: readonly string[], headBranch: string | null): string {
  const names = draft.flatMap((id) =>
    id === HEAD_OPTION_ID ? (headBranch === null ? [] : [headBranch]) : [id],
  );
  const unique = [...new Set(names)];
  return unique.length > 0 ? unique.join(', ') : (headBranch ?? '');
}

/** 직접 적은 ref 이름들 → ref 범위 (옛 대화상자의 결과): 하나면 solo, 여럿이면 branches, 없으면 null (바꾸지 않는다) */
export function revsOfNames(names: readonly string[]): GraphRevs | null {
  const [first] = names;
  if (first === undefined) {
    return null;
  }
  return names.length === 1
    ? { kind: 'solo', name: first }
    : { kind: 'branches', names: [...names] };
}

/**
 * 기본값이 아닌 보기 옵션의 이름 (보기 옵션 단추의 점·이름 — 옛 머리줄의 요약 글자를 옮긴 것). 행 수를 줄이거나 차례를
 * 바꾸는 질의 옵션만 본다 (메뉴 순서: 정렬, 원격 숨기기, 첫 부모만, 머지 제외). 레이아웃·보기 설정은 저장되는 취향이라
 * 넣지 않는다
 */
export function changedViewOptions(query: GraphQuery): string[] {
  const t = S.graph.header.summary;
  const parts: [boolean, string][] = [
    [query.sort === 'date', t.sortDate],
    [query.hideRemotes, t.hideRemotes],
    [query.firstParent, t.firstParent],
    [query.noMerges, t.noMerges],
  ];
  return parts.flatMap(([on, label]) => (on ? [label] : []));
}

/** 보기 옵션 메뉴가 읽는 상태 */
export interface RepoViewOptionsState {
  query: GraphQuery;
  layoutPrefs: GraphLayoutPrefs;
  view: GraphViewPrefs;
  /** 쓰기 진행 중 (옛 메뉴처럼 질의 옵션을 끈다) */
  busy: boolean;
}

/** 보기 옵션 메뉴가 부르는 동작 */
export interface RepoViewOptionsActions {
  setQuery: (query: GraphQuery) => void;
  setLayoutPrefs: (prefs: GraphLayoutPrefs) => void;
  setView: (patch: Partial<GraphViewPrefs>) => void;
  openColumns: () => void;
}

/**
 * 보기 옵션 메뉴 (LG-08·15): 옛 "옵션 ▾"의 전부 + 옛 필터 바의 "원격 숨기기"와 "초기화". 묶음·라벨·꺼짐은 옛 것 그대로
 * — 정렬(라디오) / 옵션(원격 숨기기·첫 부모만·머지 제외 — 쓰기 중 꺼짐) / 보기(긴 엣지 접기·기본 브랜치 고정·브랜치별
 * 색·현재 브랜치 밖 흐리게 — 늘 켜짐) / 열 설정… / 필터·옵션 초기화(질의 전부를 기본값으로 — 쓰기 중·이미 기본값이면 꺼짐)
 */
export function repoViewOptions(
  state: RepoViewOptionsState,
  act: RepoViewOptionsActions,
): DropdownItem[] {
  const o = S.graph.options;
  const { query: q, layoutPrefs: p, busy } = state;
  /** 질의 일부만 바꿔 적용한다 (git 재로드) */
  const apply = (patch: Partial<GraphQuery>) => act.setQuery({ ...q, ...patch });
  return [
    { kind: 'label', label: o.sort },
    {
      kind: 'radio',
      value: q.sort,
      disabled: busy,
      onChange: (v) => apply({ sort: v === 'date' ? 'date' : 'topo' }),
      options: [
        { value: 'topo', label: o.sortTopo },
        { value: 'date', label: o.sortDate },
      ],
    },
    { kind: 'separator' },
    { kind: 'label', label: o.filters },
    {
      kind: 'check',
      label: S.graph.filter.hideRemotes,
      checked: q.hideRemotes,
      disabled: busy,
      onChange: (v) => apply({ hideRemotes: v }),
    },
    {
      kind: 'check',
      label: o.firstParent,
      checked: q.firstParent,
      disabled: busy,
      onChange: (v) => apply({ firstParent: v }),
    },
    {
      kind: 'check',
      label: o.noMerges,
      checked: q.noMerges,
      disabled: busy,
      onChange: (v) => apply({ noMerges: v }),
    },
    { kind: 'separator' },
    { kind: 'label', label: o.view },
    {
      kind: 'check',
      label: o.collapseLongEdges,
      checked: p.collapseLongEdges,
      onChange: (v) => act.setLayoutPrefs({ ...p, collapseLongEdges: v }),
    },
    {
      kind: 'check',
      label: o.pinHead,
      checked: p.pinHead,
      onChange: (v) => act.setLayoutPrefs({ ...p, pinHead: v }),
    },
    {
      kind: 'check',
      label: o.refColors,
      checked: p.refColors,
      onChange: (v) => act.setLayoutPrefs({ ...p, refColors: v }),
    },
    {
      kind: 'check',
      label: o.dimOffHead,
      checked: state.view.dimOffHead,
      onChange: (v) => act.setView({ dimOffHead: v }),
    },
    { kind: 'separator' },
    { kind: 'item', label: S.actions.columns, onSelect: act.openColumns },
    { kind: 'separator' },
    {
      kind: 'item',
      label: S.filterBar.resetAll,
      disabled: busy || isDefaultGraphQuery(q),
      onSelect: () => act.setQuery(DEFAULT_GRAPH_QUERY),
    },
  ];
}

/**
 * 경로 범위 단추의 이름·툴팁: 모듈 범위(Project 도구 창에서 고른 모듈)로 걸린 경로면 그 모듈 이름(Project 띠의 "범위: 이름"과
 * 같은 글자)과 `경로 (모듈 범위)`, 아니면 경로 그대로
 */
export function describeScopedPath(
  path: string,
  moduleScope: string | null,
  modules: readonly Pick<Module, 'path' | 'name'>[],
): { label: string; title: string } {
  if (moduleScope !== null && path === moduleScope) {
    const name = modules.find((m) => m.path === path)?.name ?? path;
    return { label: name, title: S.filterBar.pathModule(path) };
  }
  return { label: path, title: path };
}

/**
 * 상태 글자 (폴더와 같은 규칙): 첫 로드(스트리밍)·다시 읽기 중이면 `읽는 중…`(첫 로드는 툴팁에 지금까지 읽은 수), 아니면
 * 조건이 걸렸으면 `N개 일치`, 없으면 `커밋 N개` (WIP 행은 세지 않는다). 읽기 실패면 없음
 */
export function repoLogStatus(input: {
  loadState: 'opening' | 'streaming' | 'complete' | 'error';
  reloading: boolean;
  totalRows: number;
  filtered: boolean;
}): { text: string; title?: string } | null {
  if (input.loadState === 'error') {
    return null;
  }
  const loading = input.loadState !== 'complete' || input.reloading;
  const status = timelineStatus({
    loading,
    totalRows: input.totalRows,
    filtered: input.filtered,
    info: null,
  });
  return input.loadState === 'streaming' && input.totalRows > 0
    ? { ...status, title: S.filterBar.loadedSoFar(input.totalRows) }
    : status;
}

/**
 * 로그 뷰를 다시 마운트할 열쇠 (W26 — 목록 모드와 그래프 열 폭). 로그 뷰는 본 레인 수로 그래프 열 폭을 늘리기만 하므로
 * (`packages/graph-view` 의 `maxLaneSeen`) 그래프 → 목록 모드로 바뀌면 넓은 빈 열이 남는다. 질의의 목록 모드가 바뀌거나
 * 세션이 바뀌면 곧바로 다시 마운트한다(차례를 올린다). 같으면 같은 값을 돌려준다.
 * 다시 마운트한 뷰가 아직 옛 질의의 데이터를 그릴 수 있다 — 범위 캐시는 다시 읽은 청크가 올 때까지 옛 청크를 보이고
 * (`GraphRangeCache.invalidateAll`), 코어는 질의 응답 뒤에 데이터를 준다. 그 경우는 `listRowsVerdict` 로 그린 데이터를
 * 보고 한 번 더 다시 마운트한다 (이벤트 순서에 기대지 않는다)
 */
export interface LogMount {
  session: number;
  listMode: boolean;
  epoch: number;
}

export function nextLogMount(
  prev: LogMount,
  input: { session: number; listMode: boolean },
): LogMount {
  if (input.session !== prev.session || input.listMode !== prev.listMode) {
    return { session: input.session, listMode: input.listMode, epoch: prev.epoch + 1 };
  }
  return prev;
}

/**
 * 목록 모드의 뷰가 그린 데이터가 그 질의의 것인지 (목록 모드 데이터는 레인 0·선 없음 — 코어 `list_mode`): 레인이 0 이
 * 아닌 행이나 선 조각이 있으면 `stale`(옛 그래프 데이터), 그린 행이 있고 모두 레인 0 이면 `fresh`, 그린 행이 없으면
 * `unknown`. 한 마운트가 `stale` 을 그린 뒤 `fresh` 를 그리면 그 마운트는 넓어진 열을 줄이도록 다시 마운트한다
 */
export function listRowsVerdict(slice: {
  rows: readonly ({ lane: number } | undefined)[];
  segments: readonly { lane: number }[];
}): 'stale' | 'fresh' | 'unknown' {
  if (
    slice.rows.some((r) => r !== undefined && r.lane > 0) ||
    slice.segments.some((s) => s.lane > 0)
  ) {
    return 'stale';
  }
  return slice.rows.some((r) => r !== undefined) ? 'fresh' : 'unknown';
}
