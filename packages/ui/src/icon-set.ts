// 아이콘 세트 어댑터 (LF-02). 세트에 묶인 것은 이 파일에만 둔다:
// 글꼴 CSS, 클래스 규칙, 의미 이름 → 세트의 실제 아이콘 이름.
// 지금 세트는 VS Code Codicons 다(아이콘 CC BY 4.0, 코드 MIT — THIRD-PARTY-NOTICES.md).
// 세트를 바꿀 때는 이 파일과 package.json 의존성, 고지 문서만 고친다.
import '@vscode/codicons/dist/codicon.css';

/** 의미 이름 → Codicons 아이콘 이름. 사용처는 의미 이름만 쓴다 */
export const ICON_GLYPHS = {
  // 왼쪽 띠의 도구 창
  project: 'folder',
  commit: 'git-commit',
  pullRequest: 'git-pull-request',
  git: 'source-control',
  terminal: 'terminal',

  // 트리
  chevronRight: 'chevron-right',
  chevronDown: 'chevron-down',
  rootFolder: 'root-folder',
  folder: 'folder',
  file: 'file',
  symlink: 'file-symlink-file',
  special: 'question',
  repo: 'repo',
  rescan: 'repo-sync',
  locate: 'target',
  // 저장소 탭 트리의 빌드 모듈·서브모듈 디렉터리, 모듈 범위 띠 (W25)
  module: 'package',
  submodule: 'file-submodule',
  scope: 'filter',

  // 브랜치 트리·ref 라벨
  head: 'target',
  branch: 'git-branch',
  remote: 'cloud',
  tag: 'tag',
  worktree: 'worktree',
  backup: 'archive',
  star: 'star-full',
  starEmpty: 'star-empty',
  search: 'search',
  add: 'add',
  fetch: 'git-fetch',
  // 사라진 워크트리 정리 (저장소 탭 Worktrees 그룹의 머리 단추, W22)
  prune: 'trash',
  // 태그 문서 (C3a, TG-10): 트리 Tags 묶음 끝 단추
  tagsDoc: 'list-unordered',
  expandAll: 'expand-all',
  collapseAll: 'collapse-all',
  sidebar: 'layout-sidebar-left',

  // 필터 바
  regex: 'regex',
  caseSensitive: 'case-sensitive',
  refresh: 'refresh',
  author: 'person',
  date: 'calendar',
  clearAll: 'clear-all',
  viewOptions: 'eye',
  listMode: 'list-flat',
  // 저장소 탭 필터 바의 찾기 줄 단추 (W26): 걸러내지 않고 행을 강조한다 — 텍스트 칸의 돋보기와 구분
  findInLog: 'list-selection',

  // 도구 창 머리
  maximize: 'screen-full',
  restore: 'screen-normal',
  hide: 'chrome-minimize',
  more: 'kebab-vertical',
  settings: 'settings-gear',

  // 세 상태 체크박스 (Commit 도구 창): 체크 / 일부만
  checkMark: 'check',
  checkMixed: 'dash',

  // 공통
  close: 'close',
  ok: 'pass',
  warning: 'warning',
  error: 'error',
  lock: 'lock',
} as const;

export type IconName = keyof typeof ICON_GLYPHS;

/** 의미 이름에 해당하는 세트의 CSS 클래스 문자열을 만든다 */
export function iconClassName(name: IconName): string {
  return `codicon codicon-${ICON_GLYPHS[name]}`;
}
