import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import type { EntryRow, RootRow } from '../features/project/project-tree-model';
import {
  type FolderTreeMenuActions,
  type FolderTreeMenuInput,
  folderTreeMenu,
  menuTargets,
} from '../features/workspace/folder-tree-menu';
import { repoTreeMenu } from '../features/workspace/repo-tree-menu';
import { noteRowId } from '../store/file-tree';
import { rootToRepo } from '../store/fs-path';

const ROOT = '/w/acme';
const REPOS: Record<string, string> = { api: 'api', web: 'web', 'libs/core': 'core' };
const FILES = new Set(['README.md', 'api/pom.xml']);

/** 행 하나 */
function row(path: string, entryKind: EntryRow['entryKind'] = 'dir'): EntryRow {
  return {
    kind: 'entry',
    id: path,
    path,
    name: path.split('/').at(-1) ?? path,
    entryKind,
    openable: FILES.has(path),
    expandable: entryKind === 'dir',
    expanded: false,
    size: null,
    mtimeMs: null,
    depth: 1,
    parentId: '',
    setSize: 1,
    posInSet: 1,
  };
}

const ROOT_ROW: RootRow = {
  kind: 'root',
  id: '',
  path: '',
  expanded: true,
  depth: 0,
  parentId: null,
  setSize: 1,
  posInSet: 1,
};

/** 동작 흉내 */
function actions(): FolderTreeMenuActions {
  return {
    refresh: vi.fn(),
    rescan: vi.fn(),
    openSettings: vi.fn(),
    openRepoTab: vi.fn(),
    openFile: vi.fn(),
    fetch: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
    createBranch: vi.fn(),
    checkout: vi.fn(),
    worktree: vi.fn(),
    fileHistory: vi.fn(),
    blame: vi.fn(),
    copy: vi.fn(),
  };
}

/**
 * 메뉴 입력. `fileRepo` 를 주지 않으면 저장소 세션 기능이 없는 것처럼(null) 본다 — W12 의 메뉴 모양을 그대로 확인한다.
 * W13 의 파일 히스토리·blame 은 `withRepos` 로 실제 변환(`rootToRepo`)을 넣어 확인한다
 */
function input(
  r: RootRow | EntryRow,
  targets: string[],
  busy = false,
  fileRepo: FolderTreeMenuInput['fileRepo'] = () => null,
): FolderTreeMenuInput {
  return {
    row: r,
    targets,
    root: ROOT,
    repoAt: (rel) => {
      const name = REPOS[rel];
      return name ? { path: `${ROOT}/${rel}`, name } : null;
    },
    isOpenable: (rel) => FILES.has(rel),
    fileRepo,
    repoCount: 12,
    busy,
  };
}

/** 폴더의 저장소 목록으로 파일의 가장 안쪽 저장소를 찾는 `fileRepo` (컨테이너와 같은 변환) */
const withRepos: FolderTreeMenuInput['fileRepo'] = (rel) =>
  rootToRepo(
    ROOT,
    Object.keys(REPOS).map((r) => `${ROOT}/${r}`),
    rel,
  );

const labels = (items: ReturnType<typeof folderTreeMenu>) => items.map((i) => i.label);
/** 그 이름의 항목을 누른다 */
const pick = (items: ReturnType<typeof folderTreeMenu>, label: string) => {
  const item = items.find((i) => i.label === label);
  if (!item?.onSelect) {
    throw new Error(`항목 없음: ${label}`);
  }
  item.onSelect();
};
const scoped = (label: string, scope: string) => S.folder.batch.withScope(label, scope);

describe('menuTargets (PT-07)', () => {
  const order = ['', 'api', noteRowId('status', 'api'), 'web', 'README.md'];

  it('우클릭한 행이 선택에 있으면 선택 전체(보이는 순서, 안 보이는 것은 뒤), 아니면 그 행 하나', () => {
    const selection = { web: true, api: true, 'libs/core': true } as const;
    expect(menuTargets('web', selection, order)).toEqual(['api', 'web', 'libs/core']);
    expect(menuTargets('README.md', selection, order)).toEqual(['README.md']);
  });

  it('안내 줄은 빼고, 루트는 혼자일 때만 대상이다', () => {
    expect(
      menuTargets('api', { '': true, api: true, [noteRowId('status', 'api')]: true }, order),
    ).toEqual(['api']);
    expect(menuTargets('', { '': true }, order)).toEqual(['']);
  });
});

describe('folderTreeMenu — 행 종류별 항목 (PT-07)', () => {
  it('루트: 새로고침, 다시 스캔, 폴더 설정…, 전체 Fetch, 경로 복사', () => {
    const act = actions();
    const items = folderTreeMenu(input(ROOT_ROW, ['']), act);
    expect(labels(items)).toEqual([
      S.folder.refresh,
      S.folder.rescan,
      S.project.settings,
      S.project.menu.fetchAll(12),
      S.project.menu.copyPath,
    ]);
    pick(items, S.project.menu.fetchAll(12));
    expect(act.fetch).toHaveBeenCalledWith([]);
    pick(items, S.project.settings);
    expect(act.openSettings).toHaveBeenCalled();
    pick(items, S.project.menu.copyPath);
    expect(act.copy).toHaveBeenCalledWith(ROOT);
  });

  it('저장소 하나: 저장소 탭으로 열기와 일괄 작업 6개에 그 저장소 이름을 붙인다', () => {
    const act = actions();
    const items = folderTreeMenu(input(row('api'), ['api']), act);
    expect(labels(items)).toEqual([
      S.project.openAsTab,
      scoped(S.remote.fetch, 'api'),
      scoped(S.remote.pull, 'api'),
      scoped(S.project.menu.push, 'api'),
      scoped(S.branches.toolbar.newBranch, 'api'),
      scoped(S.branches.menu.checkout, 'api'),
      scoped(S.folder.batch.worktree, 'api'),
      S.project.menu.copyPath,
    ]);
    pick(items, S.project.openAsTab);
    expect(act.openRepoTab).toHaveBeenCalledWith(`${ROOT}/api`);
    pick(items, scoped(S.project.menu.push, 'api'));
    expect(act.push).toHaveBeenCalledWith([`${ROOT}/api`]);
  });

  it('저장소 여럿: 탭으로 열기는 없고, 수를 붙이고, 선택 중 저장소만 대상이다 (다른 행은 복사에만)', () => {
    const act = actions();
    const items = folderTreeMenu(input(row('web'), ['api', 'web', 'libs/core', 'README.md']), act);
    const scope = S.project.menu.repos(3);
    expect(labels(items)).toEqual([
      scoped(S.remote.fetch, scope),
      scoped(S.remote.pull, scope),
      scoped(S.project.menu.push, scope),
      scoped(S.branches.toolbar.newBranch, scope),
      scoped(S.branches.menu.checkout, scope),
      scoped(S.folder.batch.worktree, scope),
      S.project.menu.many(S.project.menu.copyPath, 4),
    ]);
    pick(items, scoped(S.remote.fetch, scope));
    expect(act.fetch).toHaveBeenCalledWith([`${ROOT}/api`, `${ROOT}/web`, `${ROOT}/libs/core`]);
    pick(items, S.project.menu.many(S.project.menu.copyPath, 4));
    expect(act.copy).toHaveBeenCalledWith(
      [`${ROOT}/api`, `${ROOT}/web`, `${ROOT}/libs/core`, `${ROOT}/README.md`].join('\n'),
    );
  });

  it('일괄 작업이 도는 중이면 쓰기 항목을 막는다 (복사·탭으로 열기는 된다)', () => {
    const items = folderTreeMenu(input(row('api'), ['api'], true), actions());
    expect(items.filter((i) => i.disabled).map((i) => i.label)).toEqual([
      scoped(S.remote.fetch, 'api'),
      scoped(S.remote.pull, 'api'),
      scoped(S.project.menu.push, 'api'),
      scoped(S.branches.toolbar.newBranch, 'api'),
      scoped(S.branches.menu.checkout, 'api'),
      scoped(S.folder.batch.worktree, 'api'),
    ]);
    expect(
      folderTreeMenu(input(ROOT_ROW, [''], true), actions()).find(
        (i) => i.label === S.project.menu.fetchAll(12),
      )?.disabled,
    ).toBe(true);
  });

  it('일반 폴더: 경로 복사, 상대 경로 복사', () => {
    const act = actions();
    const items = folderTreeMenu(input(row('docs'), ['docs']), act);
    expect(labels(items)).toEqual([S.project.menu.copyPath, S.project.menu.copyRelative]);
    pick(items, S.project.menu.copyRelative);
    expect(act.copy).toHaveBeenCalledWith('docs');
  });

  it('파일: 열기(미리보기), 새 탭으로 열기(고정), 경로 복사, 상대 경로 복사', () => {
    const act = actions();
    const items = folderTreeMenu(input(row('api/pom.xml', 'file'), ['api/pom.xml']), act);
    expect(labels(items)).toEqual([
      S.project.menu.open,
      S.project.menu.openPinned,
      S.project.menu.copyPath,
      S.project.menu.copyRelative,
    ]);
    pick(items, S.project.menu.open);
    expect(act.openFile).toHaveBeenLastCalledWith('api/pom.xml', 'preview');
    pick(items, S.project.menu.openPinned);
    expect(act.openFile).toHaveBeenLastCalledWith('api/pom.xml', 'pinned');
    pick(items, S.project.menu.copyPath);
    expect(act.copy).toHaveBeenLastCalledWith(`${ROOT}/api/pom.xml`);
  });

  it('파일 여럿: 열 수 있는 파일을 모두 고정 탭으로 연다. 열 수 없는 항목(링크 등)은 복사만', () => {
    const act = actions();
    const items = folderTreeMenu(
      input(row('README.md', 'file'), ['api/pom.xml', 'README.md', 'docs']),
      act,
    );
    expect(labels(items)).toEqual([
      S.project.menu.many(S.project.menu.openPinned, 2),
      S.project.menu.many(S.project.menu.copyPath, 3),
      S.project.menu.many(S.project.menu.copyRelative, 3),
    ]);
    pick(items, S.project.menu.many(S.project.menu.openPinned, 2));
    expect(vi.mocked(act.openFile).mock.calls).toEqual([
      ['api/pom.xml', 'pinned'],
      ['README.md', 'pinned'],
    ]);
    expect(labels(folderTreeMenu(input(row('current', 'symlink'), ['current']), act))).toEqual([
      S.project.menu.copyPath,
      S.project.menu.copyRelative,
    ]);
  });

  it('저장소 안 파일 하나 (W13): 열기 다음에 파일 히스토리·blame, 저장소 기준 경로로 부른다', () => {
    const act = actions();
    const items = folderTreeMenu(
      input(row('api/pom.xml', 'file'), ['api/pom.xml'], false, withRepos),
      act,
    );
    expect(labels(items)).toEqual([
      S.project.menu.open,
      S.project.menu.openPinned,
      S.menu.fileHistory,
      S.menu.blame,
      S.project.menu.copyPath,
      S.project.menu.copyRelative,
    ]);
    expect(items.find((i) => i.label === S.menu.fileHistory)?.separator).toBe(true);
    pick(items, S.menu.fileHistory);
    expect(act.fileHistory).toHaveBeenCalledWith(`${ROOT}/api`, 'pom.xml');
    pick(items, S.menu.blame);
    expect(act.blame).toHaveBeenCalledWith(`${ROOT}/api`, 'pom.xml');
  });

  it('저장소 밖 파일·폴더·여러 항목 선택·열 수 없는 항목에는 파일 히스토리·blame 이 없다 (W13)', () => {
    const act = actions();
    const shown = (r: EntryRow, targets: string[]) =>
      labels(folderTreeMenu(input(r, targets, false, withRepos), act));
    // 저장소 밖 파일
    expect(shown(row('README.md', 'file'), ['README.md'])).not.toContain(S.menu.fileHistory);
    // 저장소 안 폴더
    expect(shown(row('api/src'), ['api/src'])).not.toContain(S.menu.blame);
    // 저장소 안 파일이어도 여럿을 고른 채면 없다
    expect(shown(row('api/pom.xml', 'file'), ['api/pom.xml', 'README.md'])).not.toContain(
      S.menu.fileHistory,
    );
    // 열 수 없는 항목(링크)
    expect(shown(row('api/link', 'symlink'), ['api/link'])).not.toContain(S.menu.fileHistory);
    expect(act.fileHistory).not.toHaveBeenCalled();
    expect(act.blame).not.toHaveBeenCalled();
  });
});

describe('repoTreeMenu — 저장소 탭 프로젝트 트리 (W21, 루트 1개 모드)', () => {
  const REPO = '/w/api';
  /**
   * 저장소 탭의 메뉴 입력: 루트 = 작업 트리, 파일은 그 저장소의 파일. 모듈·서브모듈·하위 저장소·상위 저장소는 없다 (W25 의
   * 항목은 `repo-structure.test.ts` 가 본다)
   */
  const repoInput = (r: RootRow | EntryRow, targets: string[]) => ({
    row: r,
    targets,
    root: REPO,
    isOpenable: (rel: string) => FILES.has(rel),
    fileRepo: (rel: string) => (FILES.has(rel) ? { repoPath: REPO, path: rel } : null),
    roles: () => null,
    superproject: null,
    scope: null,
    busy: false,
  });
  const repoActions = () => ({
    refresh: vi.fn(),
    openFile: vi.fn(),
    fileHistory: vi.fn(),
    blame: vi.fn(),
    copy: vi.fn(),
    openRepoTab: vi.fn(),
    submoduleItems: vi.fn(() => []),
    selectModule: vi.fn(),
    hideModule: vi.fn(),
  });

  it('루트는 새로고침·경로 복사뿐이다 (다시 스캔·폴더 설정·전체 Fetch 없음)', () => {
    const act = repoActions();
    const items = repoTreeMenu(repoInput(ROOT_ROW, ['']), act);
    expect(labels(items)).toEqual([S.folder.refresh, S.project.menu.copyPath]);
    pick(items, S.project.menu.copyPath);
    expect(act.copy).toHaveBeenCalledWith(REPO);
    pick(items, S.folder.refresh);
    expect(act.refresh).toHaveBeenCalledTimes(1);
  });

  it('파일·폴더는 폴더 탭의 파일 갈래와 같은 항목이다 (열기·새 탭·히스토리·Blame·경로 복사)', () => {
    const act = repoActions();
    const file = repoTreeMenu(repoInput(row('README.md', 'file'), ['README.md']), act);
    const folderTab = folderTreeMenu(
      input(row('README.md', 'file'), ['README.md'], false, (rel) =>
        FILES.has(rel) ? { repoPath: ROOT, path: rel } : null,
      ),
      actions(),
    );
    expect(labels(file)).toEqual(labels(folderTab));
    expect(labels(file)).toEqual([
      S.project.menu.open,
      S.project.menu.openPinned,
      S.menu.fileHistory,
      S.menu.blame,
      S.project.menu.copyPath,
      S.project.menu.copyRelative,
    ]);
    pick(file, S.menu.blame);
    expect(act.blame).toHaveBeenCalledWith(REPO, 'README.md');
    pick(file, S.project.menu.copyPath);
    expect(act.copy).toHaveBeenCalledWith(`${REPO}/README.md`);
    expect(labels(repoTreeMenu(repoInput(row('src'), ['src']), act))).toEqual([
      S.project.menu.copyPath,
      S.project.menu.copyRelative,
    ]);
  });
});
