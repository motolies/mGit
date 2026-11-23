import type { Module } from '@mgit/ipc';
import { Icon, S } from '@mgit/ui';
import { type ReactNode, useMemo } from 'react';
import type { MenuItem } from '../../components/ContextMenu';
import { DropdownMenu } from '../../components/DropdownMenu';
import { useDialogs } from '../../components/use-dialogs';
import toolStyles from '../../layout/ToolButton.module.css';
import { repoNameOf, useAppStore, useSession } from '../../store';
import type { RowDecoration } from '../project/project-rows';
import styles from './RepoStructure.module.css';
import {
  type DirRoles,
  dirRoles,
  ownerRepoPaths,
  repoStructureDecorations,
  rootRepoKind,
} from './repo-structure';
import { structureCounts, structureMenuItems, structureMenuShown } from './structure-menu';
import {
  promptModuleAdd,
  promptSubmoduleAdd,
  promptSubmoduleBatch,
  submoduleItems,
} from './submodule-menu';

/** 트리 위 띠 (W25): 상위 저장소 링크(옛 사이드바 맨 위의 링크)와 지금 걸린 모듈 범위(옛 "전체" 행·"범위" 배지) */
export interface RepoTreeBannerProps {
  /** 상위 저장소의 절대 경로. 서브모듈이 아니면 null */
  superproject: string | null;
  /** 지금 모듈 범위: 경로와 보일 이름. 없으면 null */
  scope: { path: string; name: string } | null;
  onOpenSuperproject: (path: string) => void;
  onClearScope: () => void;
}

/**
 * 트리 위 띠: 그릴 것이 없으면 아무것도 그리지 않는다. 한 줄에 하나씩(좁은 창에서 겹치지 않게) — 상위 저장소 링크(옛 단추와
 * 같은 글자·툴팁), 범위 줄(아이콘 + "범위: 이름" + 흐린 경로 + 해제 단추). 범위가 걸린 줄 모르면 로그가 왜 줄었는지 알 수
 * 없으므로 걸려 있는 동안 늘 보이고 한 번에 풀 수 있다
 */
export function RepoTreeBanner({
  superproject,
  scope,
  onOpenSuperproject,
  onClearScope,
}: RepoTreeBannerProps) {
  if (superproject === null && scope === null) {
    return null;
  }
  return (
    <div className={styles.banner}>
      {superproject !== null ? (
        <div className={styles.bannerRow}>
          <button
            type="button"
            className={styles.link}
            title={superproject}
            onClick={() => onOpenSuperproject(superproject)}
          >
            {S.submodule.superproject} {repoNameOf(superproject)}
          </button>
        </div>
      ) : null}
      {scope !== null ? (
        <div
          className={styles.bannerRow}
          data-kind="scope"
          title={S.project.structure.scopeTitle(scope.path)}
        >
          <span className={styles.scopeIcon}>
            <Icon name="scope" />
          </span>
          <span className={styles.scopeName}>{S.project.structure.scope(scope.name)}</span>
          <span className={styles.scopePath}>{scope.path}</span>
          <button
            type="button"
            className={toolStyles.button}
            aria-label={S.modules.clearScope}
            title={S.modules.clearScope}
            onClick={onClearScope}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** 범위 경로의 보일 이름: 그 모듈의 이름, 목록에 없으면(숨김 등) 경로 */
function scopeName(scope: string, modules: readonly Module[]): string {
  return modules.find((m) => m.path === scope)?.name ?? scope;
}

/** 저장소 탭 트리가 쓰는 모듈·서브모듈·하위 저장소 묶음 (`useRepoStructure` 의 결과) */
export interface RepoStructureParts {
  /** 작업 트리 기준 경로의 역할 (메뉴) */
  roles: (rel: string) => DirRoles | null;
  /** 역할이 있는 디렉터리의 장식 (작업 트리 기준 경로 → 장식) */
  decorations: ReadonlyMap<string, RowDecoration>;
  /** 파일이 어느 저장소의 것인지 가를 저장소 절대 경로들 (작업 트리·하위 저장소·서브모듈) */
  ownerRepos: readonly string[];
  /** 루트 행의 종류 (폴더 탭 저장소 행의 종류 배지) */
  rootKind: ReturnType<typeof rootRepoKind>;
  superproject: string | null;
  scope: string | null;
  busy: boolean;
  /** 행 메뉴가 거는 동작 (`repoTreeMenu`) */
  menu: {
    openRepoTab(path: string): void;
    submoduleItems(sm: Parameters<typeof submoduleItems>[0]): MenuItem[];
    selectModule(path: string | null): void;
    hideModule(path: string): void;
  };
  /** Project 머리의 메뉴 단추 (묶음이 하나도 없으면 null) */
  tools: ReactNode;
  /** 트리 위 띠 (`RepoTreeBanner` — 그릴 것이 없으면 아무것도 그리지 않는다) */
  banner: ReactNode;
  /** 확인·입력 대화상자 자리 (Project 도구 창과 함께 그린다) */
  dialogs: ReactNode;
}

/**
 * 저장소 탭 Project 도구 창의 모듈·서브모듈·하위 저장소 (W25, PT-13 — 옛 사이드바의 남은 네 덩이). 범위 세션의 상태를 읽어
 * 행 장식·행 메뉴의 재료·머리 메뉴·트리 위 띠를 만든다. `reveal` 은 트리에서 디렉터리를 드러내는 파일 트리 동작이다.
 * 세션 액션의 뜻은 그대로 부른다 (범위 = `selectModule` — 로그 그래프의 경로 범위, 숨기기·직접 추가 = 수동 보정)
 */
export function useRepoStructure(reveal: (path: string) => void): RepoStructureParts {
  const s = useSession((st) => ({
    root: st.path,
    modules: st.modules,
    scope: st.moduleScope,
    entries: st.status.entries,
    submodules: st.submodules,
    nestedRepos: st.nestedRepos,
    superproject: st.superproject,
    worktrees: st.refs.worktrees,
    busy: st.busy,
    inOp: st.op !== null,
    selectModule: st.selectModule,
    addManualModule: st.addManualModule,
    hideModule: st.hideModule,
    loadModules: st.loadModules,
    submoduleUpdate: st.submoduleUpdate,
    submoduleUpdateRemote: st.submoduleUpdateRemote,
    submoduleSetBranch: st.submoduleSetBranch,
    submoduleRemove: st.submoduleRemove,
    submoduleAdd: st.submoduleAdd,
    submoduleSync: st.submoduleSync,
    submoduleBatch: st.submoduleBatch,
  }));
  const openRepositoryAt = useAppStore((st) => st.openRepositoryAt);
  const dialogs = useDialogs();

  const { root, modules, scope, entries, submodules, nestedRepos, superproject, worktrees } = s;
  const roleMap = useMemo(
    () => dirRoles({ root, modules, submodules, nestedRepos }),
    [root, modules, submodules, nestedRepos],
  );
  const decorations = useMemo(
    () => repoStructureDecorations({ root, modules, scope, entries, submodules, nestedRepos }),
    [root, modules, scope, entries, submodules, nestedRepos],
  );
  const ownerRepos = useMemo(
    () => ownerRepoPaths({ root, submodules, nestedRepos }),
    [root, submodules, nestedRepos],
  );
  const rootKind = rootRepoKind(root, superproject, worktrees);

  /** 저장소를 탭으로 연다 (옛 사이드바의 더블클릭·superproject 링크와 같은 호출) */
  const openRepoTab = (path: string) => void openRepositoryAt(path);
  const items = structureMenuItems(s, {
    selectModule: (path) => void s.selectModule(path),
    reveal,
    addModule: () => void promptModuleAdd(s.addManualModule, dialogs),
    reloadModules: () => void s.loadModules(),
    addSubmodule: () => void promptSubmoduleAdd(s, dialogs),
    syncSubmodules: () => void s.submoduleSync(),
    batchSubmodules: () => void promptSubmoduleBatch(s, dialogs),
    updateSubmodules: () => void s.submoduleUpdate(true),
  });
  const title = `${S.project.structure.menu}\n${structureCounts(s)}`;

  return {
    roles: (rel) => roleMap.get(rel) ?? null,
    decorations,
    ownerRepos,
    rootKind,
    superproject,
    scope,
    busy: s.busy,
    menu: {
      openRepoTab,
      // 서브모듈의 "열기" = 그 서브모듈을 저장소 탭으로 (옛 사이드바와 같은 경로 — 작업 트리/서브모듈 경로)
      submoduleItems: (sm) =>
        submoduleItems(sm, s, dialogs, () => openRepoTab(`${root}/${sm.path}`)),
      selectModule: (path) => void s.selectModule(path),
      hideModule: (path) => void s.hideModule(path),
    },
    tools: structureMenuShown(s) ? (
      <DropdownMenu
        items={items}
        trigger={
          <button
            type="button"
            className={toolStyles.button}
            aria-label={S.project.structure.menu}
            title={title}
          >
            <Icon name="more" />
          </button>
        }
      />
    ) : null,
    banner: (
      <RepoTreeBanner
        superproject={superproject}
        scope={scope === null ? null : { path: scope, name: scopeName(scope, modules) }}
        onOpenSuperproject={openRepoTab}
        onClearScope={() => void s.selectModule(null)}
      />
    ),
    dialogs: dialogs.element,
  };
}
