// 저장소 탭 프로젝트 트리의 우클릭 메뉴 (W21, 루트 1개 모드). 루트(작업 트리)는 새로고침·경로 복사, 일반 폴더·파일은
// 폴더 탭과 같은 항목(`entryMenu`)이다. W25 에서 옛 사이드바의 항목을 디렉터리 행으로 옮겼다 — 서브모듈 디렉터리는
// 옛 서브모듈 메뉴 4개, 하위 저장소 디렉터리는 "저장소 탭으로 열기"(옛 것은 더블클릭 — 트리의 더블클릭은 펼침이다), 모듈
// 디렉터리는 범위 토글·숨기기(옛 것은 행 클릭 + 메뉴), 루트는 상위 저장소 열기(옛 맨 위 링크). 그 뒤에 일반 항목(경로 복사)이
// 구분선 다음에 그대로 붙는다 — 사라지는 항목이 없다.

import type { SubmoduleInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { MenuItem } from '../../components/ContextMenu';
import { repoNameOf } from '../../store';
import type { DirRoles } from '../modules/repo-structure';
import type { EntryRow, RootRow } from '../project/project-tree-model';
import { type EntryMenuActions, type EntryMenuInput, entryMenu } from './folder-tree-menu';

/** 저장소 탭 메뉴가 거는 동작 */
export interface RepoTreeMenuActions extends EntryMenuActions {
  refresh(): void;
  /** 저장소를 탭으로 연다 (절대 경로) — 하위 저장소, 상위 저장소 */
  openRepoTab(path: string): void;
  /** 서브모듈 하나의 옛 메뉴 4개 (`submoduleItems` — 열기·update --remote·추적 branch 지정·제거) */
  submoduleItems(sm: SubmoduleInfo): MenuItem[];
  /** 모듈 범위를 바꾼다 (null = 전체) */
  selectModule(path: string | null): void;
  hideModule(path: string): void;
}

/** 저장소 탭 메뉴를 만들 때 필요한 것 */
export type RepoTreeMenuInput = Omit<EntryMenuInput, 'row'> & {
  row: RootRow | EntryRow;
  /** 작업 트리 기준 경로의 역할 (모듈·서브모듈·하위 저장소). 없으면 null */
  roles(rel: string): DirRoles | null;
  /** 이 저장소가 서브모듈이면 상위 저장소의 절대 경로 */
  superproject: string | null;
  /** 지금 모듈 범위 */
  scope: string | null;
  /** 쓰기 명령이 도는 중 (범위 걸기를 막는다 — 옛 모듈 행 클릭과 같은 조건) */
  busy: boolean;
};

/** 묶음들을 이어 붙인다: 빈 묶음은 빼고, 둘째 묶음부터 첫 항목 앞에 구분선 */
function joinGroups(groups: readonly MenuItem[][]): MenuItem[] {
  return groups
    .filter((g) => g.length > 0)
    .flatMap((g, i) =>
      i === 0 ? g : g.map((item, j) => (j === 0 ? { ...item, separator: true } : item)),
    );
}

/**
 * 모듈 디렉터리의 항목 (옛 모듈 섹션의 행 클릭·메뉴): 지금 범위면 "범위 해제"(옛 메뉴 항목 — 꺼지지 않는다), 아니면
 * "이 모듈만 보기"(옛 행 클릭 — busy 면 꺼짐), 그리고 "목록에서 숨기기"
 */
export function moduleMenuItems(
  path: string,
  input: Pick<RepoTreeMenuInput, 'scope' | 'busy'>,
  act: Pick<RepoTreeMenuActions, 'selectModule' | 'hideModule'>,
): MenuItem[] {
  const t = S.modules;
  return [
    input.scope === path
      ? { label: t.clearScope, onSelect: () => act.selectModule(null) }
      : { label: t.scopeTo, disabled: input.busy, onSelect: () => act.selectModule(path) },
    { label: t.hide, onSelect: () => act.hideModule(path) },
  ];
}

/** 저장소 탭 프로젝트 트리 행의 우클릭 메뉴 */
export function repoTreeMenu(input: RepoTreeMenuInput, act: RepoTreeMenuActions): MenuItem[] {
  const { row, superproject } = input;
  if (row.kind === 'root') {
    return joinGroups([
      superproject !== null
        ? [
            {
              label: `${S.submodule.superproject} ${repoNameOf(superproject)}`,
              onSelect: () => act.openRepoTab(superproject),
            },
          ]
        : [],
      [
        { label: S.folder.refresh, onSelect: act.refresh },
        {
          label: S.project.menu.copyPath,
          separator: true,
          onSelect: () => act.copy(input.root),
        },
      ],
    ]);
  }
  const roles = row.entryKind === 'dir' ? input.roles(row.path) : null;
  const entry = entryMenu({ ...input, row }, act);
  if (roles === null) {
    return entry;
  }
  // 정체성 묶음(서브모듈 > 하위 저장소) → 모듈 묶음 → 일반 항목
  const repo: MenuItem[] =
    roles.submodule !== null
      ? act.submoduleItems(roles.submodule)
      : roles.nested !== null
        ? [{ label: S.project.openAsTab, onSelect: () => act.openRepoTab(roles.nested ?? '') }]
        : [];
  const module = roles.module !== null ? moduleMenuItems(roles.module.path, input, act) : [];
  return joinGroups([repo, module, entry]);
}
