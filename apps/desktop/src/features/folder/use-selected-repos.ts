import { useMemo } from 'react';
import { useFileTree, useFolder } from '../../store';
import { selectedRepoPathsIn } from '../../store/folder-store';

/**
 * 고른 저장소(프로젝트 트리 선택 중 저장소 디렉터리)의 절대 경로를 구독한다 (PT-07, WS-09). 출처는 파일 트리의
 * 선택 하나다 — 개요 탭 체크박스, 브랜치 트리·툴바·트리 메뉴의 일괄 작업이 모두 이 값을 본다. 폴더 탭이
 * 아니면 빈 목록
 */
export function useSelectedRepos(): string[] {
  const f = useFolder((st) => ({ space: st.space, repos: st.repos }));
  const selection = useFileTree((t) => t.selection);
  const space = f?.space;
  const repos = f?.repos;
  return useMemo(
    () =>
      space !== undefined && repos !== undefined && selection !== null
        ? selectedRepoPathsIn(space, repos, selection)
        : [],
    [space, repos, selection],
  );
}
