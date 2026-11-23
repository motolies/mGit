// 저장소 탭 Project 트리의 모듈·서브모듈·하위 저장소 (W25, PT-13). 옛 사이드바가 목록으로 보이던 세 가지를 트리의
// 디렉터리 행 장식으로 옮긴다 — 트리 뷰는 어느 행이 무엇인지 모르고, 컨테이너(`RepoWorkspace`)가 여기서 만든 장식을
// 경로마다 주입한다. 모두 순수 함수다 (세션 상태 조각 → 경로별 역할·장식).
//
// 겹침 규칙: 한 디렉터리가 여러 역할을 가질 수 있다 (모듈이면서 서브모듈 등). 정체성(아이콘·굵은 이름·종류 배지·메뉴의
// 앞 묶음)은 서브모듈 > 하위 저장소 > 모듈 순으로 하나만 고른다 — 저장소 경계가 동작의 뜻을 바꾸기 때문이다. 모듈은
// 저장소 행에 덧붙기만 한다: "범위" 배지, `[모듈 이름]`, 툴팁 한 줄. 저장소 행에는 모듈의 "변경 N" 을 붙이지 않는다 (상위
// 저장소의 status 에서 서브모듈·하위 저장소는 한 줄로만 잡혀 수가 뜻을 잃는다).

import type { Module, RepoKind, StatusEntry, SubmoduleInfo, WorktreeInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { baseName, relativeTo } from '../../store/fs-path';
import type { ProjectBadge, RowDecoration } from '../project/project-rows';
import { changesInModule } from './module-groups';

/** 트리가 쓰는 저장소 구조 (세션 상태에서 고른 것) */
export interface RepoStructure {
  /** 작업 트리의 절대 경로 (트리 루트) */
  root: string;
  modules: readonly Module[];
  /** 지금 걸린 모듈 범위 (작업 트리 기준 경로). null 이면 전체 */
  scope: string | null;
  /** 작업 트리 변경 (모듈 안 변경 수를 센다) */
  entries: readonly StatusEntry[];
  /** 서브모듈. 경로는 작업 트리 기준이다 */
  submodules: readonly SubmoduleInfo[];
  /** 추적되지 않는 하위 저장소의 절대 경로 */
  nestedRepos: readonly string[];
}

/** 디렉터리 하나가 맡은 역할. 여럿을 함께 맡을 수 있다 */
export interface DirRoles {
  module: Module | null;
  submodule: SubmoduleInfo | null;
  /** 하위 저장소면 그 절대 경로 */
  nested: string | null;
}

/** 역할이 하나도 없는 디렉터리 */
const NO_ROLES: DirRoles = { module: null, submodule: null, nested: null };

/**
 * 작업 트리 기준 경로 → 역할. 루트('')는 넣지 않는다 (코어는 루트를 모듈로 감지하지 않고, 루트의 종류는
 * `rootRepoKind` 가 정한다). 작업 트리 밖의 하위 저장소 경로는 버린다
 */
export function dirRoles(
  s: Pick<RepoStructure, 'root' | 'modules' | 'submodules' | 'nestedRepos'>,
): Map<string, DirRoles> {
  const out = new Map<string, DirRoles>();
  /** 그 경로의 역할 하나를 채운다 */
  const put = (path: string, patch: Partial<DirRoles>) => {
    if (path === '') {
      return;
    }
    out.set(path, { ...(out.get(path) ?? NO_ROLES), ...patch });
  };
  for (const m of s.modules) {
    put(m.path, { module: m });
  }
  for (const sm of s.submodules) {
    put(sm.path, { submodule: sm });
  }
  for (const abs of s.nestedRepos) {
    const rel = relativeTo(s.root, abs);
    if (rel !== null) {
      put(rel, { nested: abs });
    }
  }
  return out;
}

/** 서브모듈 행의 툴팁 (옛 사이드바 그대로): `경로 (describe)`, describe 가 없으면 경로 */
export function submoduleTitle(sm: SubmoduleInfo): string {
  return sm.describe ? `${sm.path} (${sm.describe})` : sm.path;
}

/** 모듈 행의 툴팁 (옛 사이드바 그대로): `경로 · 종류` */
export function moduleTitle(m: Module): string {
  return `${m.path} · ${m.kind}`;
}

/** 모듈 이름이 디렉터리 이름과 다르면 `[이름]` (IntelliJ 의 모듈 표기), 같으면 null */
function moduleDetail(m: Module): string | null {
  return m.name === baseName(m.path) ? null : `[${m.name}]`;
}

/** 서브모듈 상태 배지. 깨끗하면(문구 없음) 없다. 충돌은 진행 중 작업과 같은 주의 색 */
function submoduleStateBadge(sm: SubmoduleInfo): ProjectBadge[] {
  const text = S.submodule.status[sm.status];
  if (text === '') {
    return [];
  }
  return [{ tone: sm.status === 'conflict' ? 'op' : 'state', text }];
}

/**
 * 역할이 있는 디렉터리 행 하나의 장식 (W25, PT-13). 파일 상태(`status`)는 넣지 않는다 — 컨테이너가 상태 색인과 합친다.
 * - 서브모듈: 서브모듈 아이콘·굵은 이름, 상태 문구 + "서브모듈" 배지(폴더 탭 저장소 행의 종류 배지와 같은 글자), 툴팁
 *   `경로 (describe)`(옛 그대로) + 상태 문구 한 줄. 상태가 종류 배지보다 앞이다 — 좁은 창에서 행 끝이 잘릴 때 늘 같은
 *   "서브모듈"(아이콘이 같은 뜻을 보인다)이 먼저 잘리고 저장소마다 다른 상태가 남게
 * - 하위 저장소: 저장소 아이콘·굵은 이름(폴더 탭의 저장소 행처럼), 툴팁 = 절대 경로
 * - 모듈: 모듈 아이콘, 그 안의 변경 수, 툴팁 `경로 · 종류`
 * - 모듈이 걸리면 어느 경우든 이름이 다르면 `[이름]`, 지금 범위면 맨 앞에 "범위" 배지
 */
export function dirDecoration(
  roles: DirRoles,
  s: Pick<RepoStructure, 'scope' | 'entries'>,
): RowDecoration | null {
  const m = roles.module;
  const scopeBadge: ProjectBadge[] =
    m !== null && s.scope === m.path ? [{ tone: 'scope', text: S.modules.scopeBadge }] : [];
  const detail = m !== null ? moduleDetail(m) : null;
  const moduleLine = m !== null ? [S.project.structure.moduleLine(m.name, m.kind)] : [];
  const deco: RowDecoration = { detail };
  if (roles.submodule !== null) {
    const sm = roles.submodule;
    const state = submoduleStateBadge(sm);
    return {
      ...deco,
      icon: 'submodule',
      bold: true,
      badges: [...scopeBadge, ...state, { tone: 'kind', text: S.folder.kind.submodule }],
      title: [submoduleTitle(sm), ...state.map((b) => b.text), ...moduleLine].join('\n'),
    };
  }
  if (roles.nested !== null) {
    return {
      ...deco,
      icon: 'repo',
      iconLabel: S.project.structure.nestedIcon,
      bold: true,
      badges: scopeBadge,
      title: [roles.nested, ...moduleLine].join('\n'),
    };
  }
  if (m !== null) {
    return {
      ...deco,
      icon: 'module',
      iconLabel: S.project.structure.moduleIcon,
      badges: scopeBadge,
      changed: changesInModule(m.path, s.entries),
      title: moduleTitle(m),
    };
  }
  return null;
}

/** 저장소 구조의 행 장식 (작업 트리 기준 경로 → 장식). 역할이 있는 디렉터리만 든다 */
export function repoStructureDecorations(s: RepoStructure): Map<string, RowDecoration> {
  const out = new Map<string, RowDecoration>();
  for (const [path, roles] of dirRoles(s)) {
    const deco = dirDecoration(roles, s);
    if (deco !== null) {
      out.set(path, deco);
    }
  }
  return out;
}

/**
 * 루트(작업 트리 자신)의 종류 (폴더 탭 저장소 행의 종류 배지와 같은 갈래): 상위 저장소가 있으면 서브모듈, 이 작업 트리가
 * 주 워크트리가 아닌 연결된 워크트리면 워크트리, 아니면 standalone
 */
export function rootRepoKind(
  root: string,
  superproject: string | null,
  worktrees: readonly Pick<WorktreeInfo, 'path' | 'isMain'>[],
): RepoKind {
  if (superproject !== null) {
    return 'submodule';
  }
  const own = worktrees.find((w) => w.path === root);
  return own !== undefined && !own.isMain ? 'worktree' : 'standalone';
}

/**
 * 파일이 어느 저장소의 것인지 가를 때 쓰는 저장소 절대 경로들: 작업 트리, 하위 저장소, 서브모듈. 서브모듈 안의 파일은
 * 상위 저장소가 추적하지 않으므로 상위 세션의 히스토리·Blame 을 걸지 않는다 (하위 저장소와 같은 규칙)
 */
export function ownerRepoPaths(
  s: Pick<RepoStructure, 'root' | 'submodules' | 'nestedRepos'>,
): string[] {
  const base = s.root.replace(/\/+$/, '');
  return [s.root, ...s.nestedRepos, ...s.submodules.map((sm) => `${base}/${sm.path}`)];
}
