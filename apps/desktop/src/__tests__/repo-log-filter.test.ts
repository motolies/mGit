import type { GraphQuery, HeadState, RefLabel } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import type { DropdownItem } from '../components/DropdownMenu';
import { buildRepoBranchTree } from '../features/branches/repo-branch-tree';
import {
  clearedQuery,
  conditionSummary,
  FILTER_BAR_COMPACT_EXTRA,
  FILTER_BAR_COMPACT_MIN,
  filterBarMode,
  HEAD_OPTION_ID,
  hasConditions,
  splitList,
  withPaths,
  withText,
} from '../features/filter-bar/filter-model';
import {
  changedViewOptions,
  customRefsInitial,
  describeScopedPath,
  type LogMount,
  listRowsVerdict,
  nextLogMount,
  repoBranchOptionsOf,
  repoLogStatus,
  repoViewOptions,
  revsOfNames,
} from '../features/graph/repo-log-filter';
import { DEFAULT_GRAPH_QUERY, DEFAULT_GRAPH_VIEW, DEFAULT_LAYOUT_PREFS } from '../store';

// 저장소 탭 필터 바의 순수 규칙 (W26). 기대값은 손대기 전에 브라우저에서 모은 옛 머리줄·필터 바의 대조표다
// (스크래치패드 `w26/baseline-old-graph-header.json`)

const Q: GraphQuery = DEFAULT_GRAPH_QUERY;

/** 드롭다운 항목 → 비교용 글자 (종류:라벨, 라디오는 선택지들, 꺼짐 표시) */
function shape(items: readonly DropdownItem[]): string[] {
  return items.map((i) => {
    switch (i.kind) {
      case 'label':
        return `label:${i.label}`;
      case 'separator':
        return 'sep';
      case 'radio':
        return `radio:${i.options.map((o) => o.label).join('|')}${i.disabled ? ' (off)' : ''}`;
      case 'check':
        return `check:${i.label}${i.checked ? ' ✓' : ''}${i.disabled ? ' (off)' : ''}`;
      default:
        return `item:${i.label}${i.disabled ? ' (off)' : ''}`;
    }
  });
}

/** 보기 옵션 메뉴와 부른 동작의 기록 */
function viewMenu(state: Partial<Parameters<typeof repoViewOptions>[0]> = {}) {
  const act = {
    setQuery: vi.fn(),
    setLayoutPrefs: vi.fn(),
    setView: vi.fn(),
    openColumns: vi.fn(),
  };
  const items = repoViewOptions(
    {
      query: Q,
      layoutPrefs: DEFAULT_LAYOUT_PREFS,
      view: DEFAULT_GRAPH_VIEW,
      busy: false,
      ...state,
    },
    act,
  );
  /** 라벨로 항목 찾기 */
  const find = (label: string) =>
    items.find((i) => i.kind !== 'separator' && 'label' in i && i.label === label);
  return { items, act, find };
}

describe('보기 옵션 메뉴 = 옛 "옵션 ▾" + 옛 필터 바의 원격 숨기기·초기화 (대조, LG-15)', () => {
  it('묶음·라벨·순서: 옛 메뉴 그대로에 원격 숨기기(옵션 묶음 맨 앞)와 끝의 "필터·옵션 초기화"가 더해졌다', () => {
    const o = S.graph.options;
    expect(shape(viewMenu().items)).toEqual([
      `label:${o.sort}`,
      `radio:${o.sortTopo}|${o.sortDate}`,
      'sep',
      `label:${o.filters}`,
      `check:${S.graph.filter.hideRemotes}`,
      `check:${o.firstParent}`,
      `check:${o.noMerges}`,
      'sep',
      `label:${o.view}`,
      `check:${o.collapseLongEdges} ✓`,
      `check:${o.pinHead} ✓`,
      `check:${o.refColors} ✓`,
      `check:${o.dimOffHead} ✓`,
      'sep',
      `item:${S.actions.columns}`,
      'sep',
      `item:${S.filterBar.resetAll} (off)`,
    ]);
    // 옛 라벨 글자 (기준 캡처의 글자)
    expect([o.sort, o.sortTopo, o.sortDate, o.filters, o.firstParent, o.noMerges]).toEqual([
      '정렬',
      '토폴로지 순',
      '커밋 날짜순',
      '옵션',
      '첫 부모만',
      '병합 커밋 제외',
    ]);
    expect([o.collapseLongEdges, o.pinHead, o.refColors, o.dimOffHead, S.actions.columns]).toEqual([
      '긴 엣지 접기',
      '기본 브랜치 고정',
      '브랜치별 색',
      '현재 브랜치 밖 흐리게',
      '그래프 열 설정…',
    ]);
    expect(S.graph.filter.hideRemotes).toBe('원격 숨기기');
  });

  it('쓰기 중(busy)에는 옛 것처럼 정렬·첫 부모만·머지 제외(+원격 숨기기·초기화)가 꺼지고, 보기 넷·열 설정은 켜져 있다', () => {
    const o = S.graph.options;
    const busy = shape(viewMenu({ busy: true, query: { ...Q, sort: 'date' } }).items);
    expect(busy).toContain(`radio:${o.sortTopo}|${o.sortDate} (off)`);
    expect(busy).toContain(`check:${S.graph.filter.hideRemotes} (off)`);
    expect(busy).toContain(`check:${o.firstParent} (off)`);
    expect(busy).toContain(`check:${o.noMerges} (off)`);
    expect(busy).toContain(`check:${o.collapseLongEdges} ✓`);
    expect(busy).toContain(`check:${o.dimOffHead} ✓`);
    expect(busy).toContain(`item:${S.actions.columns}`);
    expect(busy).toContain(`item:${S.filterBar.resetAll} (off)`);
  });

  it('각 항목이 바꾸는 것: 질의(정렬·원격 숨기기·첫 부모·머지 제외·초기화) / 레이아웃 설정 / 보기 설정 / 열 설정 흐름', () => {
    const q: GraphQuery = { ...Q, revs: { kind: 'solo', name: 'main' } };
    const { items, act, find } = viewMenu({ query: q });
    const radio = items.find((i) => i.kind === 'radio');
    if (radio?.kind === 'radio') {
      radio.onChange('date');
    }
    expect(act.setQuery).toHaveBeenLastCalledWith({ ...q, sort: 'date' });
    const check = (label: string, v: boolean) => {
      const item = find(label);
      if (item?.kind === 'check') {
        item.onChange(v);
      }
    };
    check(S.graph.filter.hideRemotes, true);
    expect(act.setQuery).toHaveBeenLastCalledWith({ ...q, hideRemotes: true });
    check(S.graph.options.firstParent, true);
    expect(act.setQuery).toHaveBeenLastCalledWith({ ...q, firstParent: true });
    check(S.graph.options.noMerges, true);
    expect(act.setQuery).toHaveBeenLastCalledWith({ ...q, noMerges: true });
    check(S.graph.options.collapseLongEdges, false);
    expect(act.setLayoutPrefs).toHaveBeenLastCalledWith({
      ...DEFAULT_LAYOUT_PREFS,
      collapseLongEdges: false,
    });
    check(S.graph.options.pinHead, false);
    expect(act.setLayoutPrefs).toHaveBeenLastCalledWith({
      ...DEFAULT_LAYOUT_PREFS,
      pinHead: false,
    });
    check(S.graph.options.refColors, false);
    expect(act.setLayoutPrefs).toHaveBeenLastCalledWith({
      ...DEFAULT_LAYOUT_PREFS,
      refColors: false,
    });
    check(S.graph.options.dimOffHead, false);
    expect(act.setView).toHaveBeenLastCalledWith({ dimOffHead: false });
    const columns = find(S.actions.columns);
    if (columns?.kind === 'item') {
      columns.onSelect();
    }
    expect(act.openColumns).toHaveBeenCalledTimes(1);
    // 옛 "초기화"·머리줄 × 와 같다: 질의 전부를 기본값으로
    const reset = find(S.filterBar.resetAll);
    expect(reset?.kind === 'item' && reset.disabled).toBe(false);
    if (reset?.kind === 'item') {
      reset.onSelect();
    }
    expect(act.setQuery).toHaveBeenLastCalledWith(DEFAULT_GRAPH_QUERY);
  });

  it('기본값이 아닌 보기 옵션의 이름 (옛 머리줄 요약 글자 — 메뉴 순서)', () => {
    expect(changedViewOptions(Q)).toEqual([]);
    expect(
      changedViewOptions({
        ...Q,
        sort: 'date',
        hideRemotes: true,
        firstParent: true,
        noMerges: true,
      }),
    ).toEqual(['날짜순', '원격 숨김', '첫 부모만', '병합 커밋 제외']);
    // 조건(ref·경로·텍스트)과 레이아웃 설정은 보기 옵션이 아니다
    expect(changedViewOptions(withPaths({ ...Q, revs: { kind: 'head' } }, ['src']))).toEqual([]);
  });
});

describe('branch 드롭다운 ↔ ref 범위 (옛 "표시할 ref", 대조)', () => {
  const HEAD_OID = 'a'.repeat(40);
  const label = (fullName: string, kind: RefLabel['kind'], current = false): RefLabel =>
    ({
      fullName,
      shortName: fullName.replace(/^refs\/(heads|remotes|tags)\//, ''),
      kind,
      target: HEAD_OID,
      isCurrent: current,
      upstream: null,
      ahead: 0,
      behind: 0,
      gone: false,
    }) as unknown as RefLabel;
  const head: HeadState = { state: 'attached', branch: 'main', oid: HEAD_OID };
  const nodes = buildRepoBranchTree({
    labels: [
      label('refs/heads/feature/x', { kind: 'localBranch' }),
      label('refs/heads/main', { kind: 'localBranch' }, true),
      label('refs/remotes/origin/main', { kind: 'remoteBranch', remote: 'origin' }),
      label('refs/remotes/origin/dev', { kind: 'remoteBranch', remote: 'origin' }),
      label('refs/tags/v1.0', { kind: 'tag', annotated: false }),
    ],
    head,
    worktrees: [],
    backups: [],
    radar: [],
    path: '/r',
    tagReports: {},
    remoteNames: [],
    tagChecking: false,
    isFavorite: () => false,
  });

  it('브랜치 트리의 잎과 같은 목록·순서이고, 이름은 질의에 실리는 ref 이름이다 (원격은 origin/main — 트리 메뉴의 solo 와 같은 값). 태그는 없다', () => {
    expect(repoBranchOptionsOf(nodes)).toEqual([
      { name: 'main', remote: false, current: true, title: 'refs/heads/main' },
      { name: 'feature/x', remote: false, current: false, title: 'refs/heads/feature/x' },
      { name: 'origin/dev', remote: true, current: false, title: 'refs/remotes/origin/dev' },
      { name: 'origin/main', remote: true, current: false, title: 'refs/remotes/origin/main' },
    ]);
  });

  it('"ref 이름 입력…" 의 처음 값: 초안을 쉼표로 잇고 HEAD 는 현재 branch 로. 초안이 없으면 옛 규칙대로 현재 branch', () => {
    // 옛 대화상자의 처음 값과 같다: branches → 이름들, solo → 그 이름, 그 밖 → 현재 branch(없으면 빈 칸)
    expect(customRefsInitial(['main', 'origin/dev'], 'main')).toBe('main, origin/dev');
    expect(customRefsInitial(['v1.0'], 'main')).toBe('v1.0');
    expect(customRefsInitial([], 'main')).toBe('main');
    expect(customRefsInitial([], null)).toBe('');
    // HEAD 항목: 현재 branch 이름으로, 분리 HEAD 면 뺀다
    expect(customRefsInitial([HEAD_OPTION_ID], 'main')).toBe('main');
    expect(customRefsInitial([HEAD_OPTION_ID], null)).toBe('');
  });

  it('직접 적은 이름 → ref 범위: 쉼표·앞뒤 공백·빈 항목 규칙, 하나면 solo, 여럿이면 branches, 없으면 바꾸지 않음', () => {
    expect(splitList(' main ,  origin/dev, ,')).toEqual(['main', 'origin/dev']);
    expect(revsOfNames(splitList('v1.0'))).toEqual({ kind: 'solo', name: 'v1.0' });
    expect(revsOfNames(splitList('main, development'))).toEqual({
      kind: 'branches',
      names: ['main', 'development'],
    });
    expect(revsOfNames(splitList(' , '))).toBeNull();
  });
});

describe('경로 범위 (옛 경로 입력, 대조)', () => {
  it('쉼표 구분·앞뒤 공백·빈 항목 규칙은 옛 입력과 같고, 경로는 조건이다 (모두 지우기·결과 없음 요약에 든다)', () => {
    // 기준 캡처: ' src ,  docs, ' → ['src', 'docs']
    const q = withPaths(Q, splitList(' src ,  docs, '));
    expect(q.pathScope).toEqual(['src', 'docs']);
    expect(hasConditions(q)).toBe(true);
    expect(hasConditions(Q)).toBe(false);
    // 필드가 없는 값(폴더 쪽 옛 호출)은 경로 조건이 없다
    expect(hasConditions({ revs: { kind: 'all' }, filter: Q.filter })).toBe(false);
    const cleared = clearedQuery({ ...q, sort: 'date', hideRemotes: true });
    expect(cleared.pathScope).toEqual([]);
    expect(cleared.sort).toBe('date');
    expect(cleared.hideRemotes).toBe(true);
    expect(
      conditionSummary(withText(q, { pattern: 'fix', regex: false, matchCase: false }), {
        now: new Date(2025, 9, 28),
        pathLabel: (p) => (p === 'src' ? 'source' : p),
      }),
    ).toEqual([S.filterBar.textCondition('fix', false), '경로: source +1']);
  });

  it('모듈 범위로 걸린 경로는 모듈 이름(Project 띠와 같은 글자)과 "(모듈 범위)" 툴팁, 아니면 경로 그대로', () => {
    const mods = [{ path: 'src/features/cart', name: 'cart' }];
    expect(describeScopedPath('src/features/cart', 'src/features/cart', mods)).toEqual({
      label: 'cart',
      title: S.filterBar.pathModule('src/features/cart'),
    });
    expect(describeScopedPath('src/features/cart', null, mods)).toEqual({
      label: 'src/features/cart',
      title: 'src/features/cart',
    });
  });
});

describe('상태 글자 (폴더와 같은 규칙)', () => {
  it.each<[string, Parameters<typeof repoLogStatus>[0], { text: string; title?: string } | null]>([
    [
      '처음 여는 중',
      { loadState: 'opening', reloading: false, totalRows: 0, filtered: false },
      { text: S.folder.timeline.loading },
    ],
    [
      '스트리밍 중 — 툴팁에 지금까지 읽은 수',
      { loadState: 'streaming', reloading: false, totalRows: 500, filtered: false },
      { text: S.folder.timeline.loading, title: S.filterBar.loadedSoFar(500) },
    ],
    [
      '다시 읽는 중',
      { loadState: 'complete', reloading: true, totalRows: 9, filtered: true },
      { text: S.folder.timeline.loading },
    ],
    [
      '조건 없음',
      { loadState: 'complete', reloading: false, totalRows: 2000, filtered: false },
      { text: S.folder.timeline.rows(2000) },
    ],
    [
      '조건 있음',
      { loadState: 'complete', reloading: false, totalRows: 250, filtered: true },
      { text: S.folder.timeline.matched(250) },
    ],
    ['읽기 실패', { loadState: 'error', reloading: false, totalRows: 0, filtered: false }, null],
  ])('%s', (_name, input, expected) => {
    expect(repoLogStatus(input)).toEqual(expected);
  });
});

describe('목록 모드의 로그 뷰 다시 마운트 (W26)', () => {
  const start: LogMount = { session: 1, listMode: false, epoch: 0 };

  it('질의의 목록 모드가 바뀌거나 세션이 바뀔 때만 차례가 오른다', () => {
    expect(nextLogMount(start, { session: 1, listMode: false })).toBe(start);
    const list = nextLogMount(start, { session: 1, listMode: true });
    expect(list).toEqual({ session: 1, listMode: true, epoch: 1 });
    expect(nextLogMount(list, { session: 1, listMode: true })).toBe(list);
    expect(nextLogMount(list, { session: 1, listMode: false }).epoch).toBe(2);
    expect(nextLogMount(list, { session: 2, listMode: true }).epoch).toBe(2);
  });

  it('그린 데이터: 레인이 있는 행·선 조각 = 옛 그래프 데이터, 모두 레인 0 = 목록 데이터, 행이 없으면 모름', () => {
    const row = (lane: number) => ({ lane });
    expect(listRowsVerdict({ rows: [row(0), row(2)], segments: [] })).toBe('stale');
    expect(listRowsVerdict({ rows: [row(0)], segments: [{ lane: 1 }] })).toBe('stale');
    expect(listRowsVerdict({ rows: [row(0), undefined, row(0)], segments: [] })).toBe('fresh');
    expect(listRowsVerdict({ rows: [undefined], segments: [] })).toBe('unknown');
  });
});

describe('좁은 폭: 도구 단추 (W26)', () => {
  it('도구 단추 하나만큼 좁은 한 줄에 더 필요하다 (주지 않으면 지금 그대로)', () => {
    const none = { active: 0, clearAll: false, listMode: false };
    expect(filterBarMode(FILTER_BAR_COMPACT_MIN, none)).toBe('compact');
    expect(filterBarMode(FILTER_BAR_COMPACT_MIN, { ...none, tools: 1 })).toBe('stacked');
    expect(
      filterBarMode(FILTER_BAR_COMPACT_MIN + FILTER_BAR_COMPACT_EXTRA, { ...none, tools: 1 }),
    ).toBe('compact');
    // 960×600 저장소 탭(로그 칸 약 492px, 내용 폭 약 476px): 조건 없음 + 찾기 단추는 한 줄
    expect(filterBarMode(476, { ...none, tools: 1 })).toBe('compact');
  });
});
