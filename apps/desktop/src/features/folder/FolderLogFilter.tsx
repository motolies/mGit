import type { FolderBranchRepo, GraphQuery, TimelineInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useMemo } from 'react';
import { focusPanel } from '../../actions';
import type { DropdownItem } from '../../components/DropdownMenu';
import { useFolder } from '../../store';
import type { BranchTreeNode } from '../branches/branch-tree-model';
import { leafNodes } from '../branches/branch-tree-model';
import { describeRevs, headRevs } from '../branches/folder-branch-tree';
import {
  type AuthorSource,
  type BranchOption,
  FilterBar,
  type RepoOption,
} from '../filter-bar/FilterBar';
import { hasConditions } from '../filter-bar/filter-model';

/** 능력 플래그: 폴더 로그는 저장소 범위를 고를 수 있다 */
const FOLDER_CAPABILITIES = { repoScope: true } as const;

/**
 * 브랜치 트리의 잎 → branch 드롭다운 항목. 트리와 같은 목록·순서(현재 > 즐겨찾기 > 이름)이고 원격 숨기기도 트리처럼
 * 따른다. HEAD 행은 드롭다운의 HEAD 항목이 따로 맡는다
 */
export function branchOptionsOf(nodes: readonly BranchTreeNode[]): BranchOption[] {
  return leafNodes(nodes).flatMap((node) =>
    node.kind === 'local' || node.kind === 'remote'
      ? [
          {
            name: node.label,
            remote: node.kind === 'remote',
            current: node.current ?? false,
            title: [`${node.label} ${node.suffix ?? ''}`.trim(), node.currentTitle]
              .filter(Boolean)
              .join('\n'),
          },
        ]
      : [],
  );
}

/** 타임라인 정보의 저장소 → 저장소 드롭다운 항목 (범위 밖·읽기 실패 저장소도 모두, 순번순) */
export function repoOptionsOf(info: TimelineInfo | null): RepoOption[] {
  return (info?.repos ?? []).map((r) => ({
    path: r.path,
    name: r.name,
    color: r.color,
    error: r.error ?? null,
  }));
}

/**
 * 상태 글자 (LG-08): 읽는 중 / 행 수(필터가 걸렸으면 `N개 일치`) + 잘림. 잘림은 저장소당 상한에 걸렸다는 뜻이고, 필터가
 * 걸렸으면 "걸러진 결과가 상한을 넘었다"는 뜻이다 (W16). 툴팁에 잘린 저장소 이름
 */
export function timelineStatus(input: {
  loading: boolean;
  totalRows: number;
  filtered: boolean;
  info: TimelineInfo | null;
}): { text: string; title?: string } {
  const t = S.folder.timeline;
  if (input.loading) {
    return { text: t.loading };
  }
  const count = input.filtered ? t.matched(input.totalRows) : t.rows(input.totalRows);
  const truncated = (input.info?.repos ?? []).filter((r) => r.truncated && r.inScope);
  if (truncated.length === 0 || !input.info) {
    return { text: count };
  }
  const cap = input.info.maxPerRepo;
  const note = input.filtered ? t.truncatedFiltered(cap) : t.truncated(cap);
  return {
    text: `${count} · ${note}`,
    title: t.truncatedRepos(truncated.map((r) => r.name).join(', ')),
  };
}

interface FolderLogFilterProps {
  /** 브랜치 트리의 노드 (branch 드롭다운이 같은 목록을 쓴다) */
  branchNodes: readonly BranchTreeNode[];
  /** 브랜치 목록의 저장소 (HEAD 항목의 툴팁: 저장소마다의 HEAD) */
  branchRepos: readonly FolderBranchRepo[];
}

/**
 * 폴더 로그의 필터 바 (W17): 폴더 스토어의 질의·저장소 범위·작성자 후보를 필터 바에 잇는다. branch 드롭다운은
 * 브랜치 트리와 같은 상태(질의의 ref 범위)라 한쪽에서 고르면 다른 쪽도 바뀐다. 보기 옵션에는 타임라인이 실제로
 * 지키는 것만 싣는다: 원격 숨기기, 첫 부모만, 머지 제외(질의), 긴 엣지 접기(레이아웃 설정). 정렬은 싣지 않는다 —
 * 타임라인은 저장소별 로그를 커밋 시각으로 합치므로 토폴로지 순을 지킬 수 없다. 고정 레인·ref 색도 타임라인
 * 레이아웃이 쓰지 않는다
 */
export function FolderLogFilter({ branchNodes, branchRepos }: FolderLogFilterProps) {
  const f = useFolder((st) => ({
    timeline: st.timeline,
    batchProgress: st.batchProgress,
    setTimelineQuery: st.setTimelineQuery,
    setTimelineScope: st.setTimelineScope,
    setTimelinePrefs: st.setTimelinePrefs,
    clearFilterError: st.clearFilterError,
    loadTimelineAuthors: st.loadTimelineAuthors,
    reloadTimeline: st.reloadTimeline,
  }));
  const info = f?.timeline.info ?? null;
  const repoOptions = useMemo(() => repoOptionsOf(info), [info]);
  const branchOptions = useMemo(() => branchOptionsOf(branchNodes), [branchNodes]);
  const headTitle = useMemo(() => describeRevs(headRevs(), branchRepos)?.title, [branchRepos]);
  if (!f) {
    return null;
  }
  const tl = f.timeline;
  const query = tl.query;
  const setQuery = (next: GraphQuery) => void f.setTimelineQuery(next);
  const filtered = hasConditions(query) || tl.scope.length > 0;
  const status = timelineStatus({
    loading: tl.loadState === 'loading',
    totalRows: tl.totalRows,
    filtered,
    info,
  });
  const batch = f.batchProgress;
  const o = S.graph.options;
  const viewOptions: DropdownItem[] = [
    {
      kind: 'check',
      label: S.folder.timeline.hideRemotes,
      checked: query.hideRemotes,
      onChange: (v) => setQuery({ ...query, hideRemotes: v }),
    },
    {
      kind: 'check',
      label: o.firstParent,
      checked: query.firstParent,
      onChange: (v) => setQuery({ ...query, firstParent: v }),
    },
    {
      kind: 'check',
      label: o.noMerges,
      checked: query.noMerges,
      onChange: (v) => setQuery({ ...query, noMerges: v }),
    },
    { kind: 'separator' },
    {
      kind: 'check',
      label: o.collapseLongEdges,
      checked: tl.prefs.collapseLongEdges,
      onChange: (v) => void f.setTimelinePrefs({ ...tl.prefs, collapseLongEdges: v }),
    },
  ];
  const authors: AuthorSource = {
    state: tl.authors.state,
    list: tl.authors.list,
    error: tl.authors.error,
    load: f.loadTimelineAuthors,
  };

  return (
    <FilterBar
      query={query}
      onQueryChange={setQuery}
      capabilities={FOLDER_CAPABILITIES}
      repos={{
        options: repoOptions,
        scope: tl.scope,
        onScopeChange: (paths) => void f.setTimelineScope(paths),
      }}
      branches={{
        options: branchOptions,
        headAvailable: branchNodes.some((node) => node.kind === 'head'),
        headTitle,
      }}
      authors={authors}
      textError={tl.filterError}
      onTextEdit={f.clearFilterError}
      // 적용된 값 그대로에서 누른 Esc: 포커스를 로그로 돌린다
      onEscape={() => focusPanel('git-log')}
      status={
        batch
          ? `${status.text} · ${S.folder.batch.running(batch.label, batch.phase)}${batch.percent !== null ? ` ${batch.percent}%` : ''}`
          : status.text
      }
      statusTitle={status.title}
      viewOptions={viewOptions}
      onRefresh={() => void f.reloadTimeline()}
      refreshing={tl.loadState === 'loading'}
    />
  );
}
