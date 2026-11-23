import type { GraphQuery } from '@mgit/ipc';
import { formatShortcut, S } from '@mgit/ui';
import { useMemo, useState } from 'react';
import { focusPanel, SEARCH_SHORTCUT } from '../../actions';
import { str, useDialogs } from '../../components/use-dialogs';
import { getSessionStore, headBranchOf, useAppStore, useSession } from '../../store';
import { isFavorite, readFavoriteOverrides } from '../branches/branch-favorites';
import { buildRepoBranchTree, headCommit } from '../branches/repo-branch-tree';
import { type AuthorSource, FilterBar, type FilterBarTool } from '../filter-bar/FilterBar';
import { hasConditions, sameQuery, splitList, withRevs } from '../filter-bar/filter-model';
import { columnsFlow } from '../history/flows';
import {
  changedViewOptions,
  customRefsInitial,
  describeScopedPath,
  repoBranchOptionsOf,
  repoLogStatus,
  repoViewOptions,
  revsOfNames,
} from './repo-log-filter';

/** 능력 플래그: 저장소 탭은 저장소 범위가 없고 경로 범위가 있다 */
const REPO_CAPABILITIES = { repoScope: false, pathScope: true } as const;

/**
 * 저장소 탭 로그의 필터 바 (LG-15, W26): 세션의 질의·작성자 후보·보기 설정을 공용 필터 바에 잇는다. 옛 그래프 머리줄과
 * 필터 바의 자리다 — 표시할 ref 는 branch 드롭다운(브랜치 트리와 같은 목록, HEAD·solo·branches, "ref 이름 입력…"),
 * 경로 범위는 경로 드롭다운, 정렬·첫 부모·머지 제외·원격 숨기기·보기 넷·열 설정·초기화는 보기 옵션 메뉴, "검색"은 찾기
 * 단추(찾기 줄을 여닫는다 — 줄은 필터 바 아래). 텍스트·작성자·날짜 필터는 새로 생겼다.
 * 쓰기가 도는 동안(busy)은 질의를 바꾸는 조작이 잠긴다 (옛 바도 ref·경로·정렬·옵션을 껐다)
 */
export function RepoLogFilter() {
  const s = useSession((st) => ({
    id: st.id,
    path: st.path,
    labels: st.refs.labels,
    head: st.refs.head,
    headBranch: headBranchOf(st.refs),
    query: st.graphQuery,
    setGraphQuery: st.setGraphQuery,
    filterError: st.filterError,
    clearFilterError: st.clearFilterError,
    authors: st.graphAuthors,
    loadGraphAuthors: st.loadGraphAuthors,
    busy: st.busy,
    layoutPrefs: st.layoutPrefs,
    setGraphLayoutPrefs: st.setGraphLayoutPrefs,
    graphView: st.graphView,
    setGraphViewPrefs: st.setGraphViewPrefs,
    graphColumns: st.graphColumns,
    setGraphColumns: st.setGraphColumns,
    searchOpen: st.search.open,
    setSearchOpen: st.setSearchOpen,
    loadState: st.loadState,
    reloading: st.reloading,
    totalRows: st.totalRows,
    reloadGraph: st.reloadGraph,
    moduleScope: st.moduleScope,
    modules: st.modules,
  }));
  const searchKey = useAppStore((a) => a.shortcutOverrides['view.search']);
  const dialogs = useDialogs();
  // 즐겨찾기는 브랜치 트리가 바꾼다 (다른 훅 인스턴스라 바뀐 것이 여기로 오지 않는다): branch 드롭다운을 열 때마다 다시 읽어
  // 트리와 같은 순서로 보인다
  const [favoritesEpoch, setFavoritesEpoch] = useState(0);
  const branchNodes = useMemo(() => {
    // 드롭다운을 연 차례마다 저장된 즐겨찾기를 다시 읽는다
    void favoritesEpoch;
    const favorites = readFavoriteOverrides(s.path);
    return buildRepoBranchTree({
      labels: s.labels,
      head: s.head,
      worktrees: [],
      backups: [],
      radar: [],
      path: s.path,
      // branch 고르기 드롭다운은 tag 상태를 쓰지 않는다
      tagReports: {},
      remoteNames: [],
      tagChecking: false,
      isFavorite: (fullName) => isFavorite(favorites, fullName),
    });
  }, [s.labels, s.head, s.path, favoritesEpoch]);
  const branchOptions = useMemo(() => repoBranchOptionsOf(branchNodes), [branchNodes]);

  const query = s.query;
  const setQuery = (next: GraphQuery) => void s.setGraphQuery(next);
  const headOid = headCommit(s.head);

  /**
   * "ref 이름 입력…" (옛 "ref 고르기…" 대화상자 그대로): 드롭다운의 초안에서 시작해 쉼표로 적은 이름을 건다. 하나면 solo,
   * 여럿이면 branches, 비면 바꾸지 않는다. 대화상자가 떠 있는 사이 바뀐 질의 위에 건다
   */
  const editCustomRefs = async (draft: string[]) => {
    const v = await dialogs.prompt({
      title: S.graph.filter.customTitle,
      fields: [
        {
          key: 'names',
          label: S.graph.filter.customField,
          initial: customRefsInitial(draft, s.headBranch),
          required: true,
        },
      ],
      confirmLabel: S.dialog.apply,
    });
    if (!v) {
      return;
    }
    const revs = revsOfNames(splitList(str(v, 'names')));
    const st = getSessionStore(s.id)?.getState();
    if (revs === null || !st) {
      return;
    }
    const next = withRevs(st.graphQuery, revs);
    if (!sameQuery(next, st.graphQuery)) {
      void st.setGraphQuery(next);
    }
  };

  const authors: AuthorSource = {
    state: s.authors.state,
    list: s.authors.list,
    error: s.authors.error,
    load: s.loadGraphAuthors,
  };
  const status = repoLogStatus({
    loadState: s.loadState,
    reloading: s.reloading,
    totalRows: s.totalRows,
    filtered: hasConditions(query),
  });
  const viewOptions = repoViewOptions(
    { query, layoutPrefs: s.layoutPrefs, view: s.graphView, busy: s.busy },
    {
      setQuery,
      setLayoutPrefs: (prefs) => void s.setGraphLayoutPrefs(prefs),
      setView: s.setGraphViewPrefs,
      openColumns: () => void columnsFlow(dialogs, s),
    },
  );
  // 찾기 줄(하이라이트·다음·이전·고급) 여닫기: 옛 머리줄의 "검색" 단추 자리. 툴팁에는 ⌘F(사용자가 바꿨으면 그 키)
  const key = searchKey === undefined ? SEARCH_SHORTCUT : searchKey;
  const tools: FilterBarTool[] = [
    {
      key: 'find',
      icon: 'findInLog',
      label: S.filterBar.find,
      title: S.filterBar.findTitle(key === null ? null : formatShortcut(key)),
      pressed: s.searchOpen,
      onClick: () => s.setSearchOpen(!s.searchOpen),
    },
  ];

  return (
    <>
      <FilterBar
        query={query}
        onQueryChange={setQuery}
        capabilities={REPO_CAPABILITIES}
        branches={{
          options: branchOptions,
          headAvailable: headOid !== null,
          headTitle:
            headOid === null
              ? undefined
              : S.filterBar.headTitle(s.headBranch ?? headOid.slice(0, 8)),
          missingSection: S.filterBar.otherRefs,
          custom: { label: S.filterBar.customRefs, onEdit: (draft) => void editCustomRefs(draft) },
          onOpen: () => setFavoritesEpoch((n) => n + 1),
        }}
        describePath={(path) => describeScopedPath(path, s.moduleScope, s.modules)}
        authors={authors}
        textError={s.filterError}
        onTextEdit={s.clearFilterError}
        // 적용된 값 그대로에서 누른 Esc: 포커스를 로그로 돌린다
        onEscape={() => focusPanel('git-log')}
        status={status?.text}
        statusTitle={status?.title}
        viewOptions={viewOptions}
        viewOptionsChanged={changedViewOptions(query)}
        tools={tools}
        onRefresh={() => void s.reloadGraph()}
        refreshing={s.reloading || s.loadState === 'opening' || s.loadState === 'streaming'}
        locked={s.busy}
      />
      {dialogs.element}
    </>
  );
}
