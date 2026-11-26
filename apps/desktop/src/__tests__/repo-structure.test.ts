// W25: 저장소 탭 Project 트리의 모듈·서브모듈·하위 저장소·상위 저장소 (PT-13) — 순수 함수의 계약.
// - 대조: 옛 사이드바(`Sidebar.tsx`·`ModulesSection.tsx`·`submodule-menu.ts`)의 메뉴·머리 단추·대화상자 글자, 꺼짐·위험 표시,
//   부르는 동작과 인자. 기대값은 손대기 전 브라우저에서 모은 기준(스크래치패드 `w25/baseline-old-sidebar.json`)과 옛 코드다.
// - 행 장식 (`repo-structure.ts`): 역할마다의 아이콘·굵기·배지·변경 수·툴팁, 겹칠 때의 규칙, 루트의 종류.
// - 행 메뉴 (`repoTreeMenu`): 서브모듈·하위 저장소·모듈 디렉터리와 루트(상위 저장소)의 항목과 묶음 순서.
// - 머리 메뉴 (`structure-menu.ts`): 보이는 조건, 항목·꺼짐·현재 표시, 고르면 부르는 동작.

import type { Module, StatusEntry, SubmoduleInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../components/ContextMenu';
import type { DropdownItem } from '../components/DropdownMenu';
import type { useDialogs } from '../components/use-dialogs';
import {
  dirDecoration,
  dirRoles,
  ownerRepoPaths,
  repoStructureDecorations,
  rootRepoKind,
} from '../features/modules/repo-structure';
import {
  ALL_MODULES,
  type StructureMenuState,
  showsModules,
  structureCounts,
  structureMenuItems,
  structureMenuShown,
} from '../features/modules/structure-menu';
import {
  promptModuleAdd,
  promptSubmoduleAdd,
  promptSubmoduleBatch,
  type SubmoduleActions,
  submoduleItems,
} from '../features/modules/submodule-menu';
import type { EntryRow, RootRow } from '../features/project/project-tree-model';
import { moduleMenuItems, repoTreeMenu } from '../features/workspace/repo-tree-menu';

type Dialogs = ReturnType<typeof useDialogs>;

const ROOT = '/mock/storefront-web';

/** 목 장면과 같은 모듈 다섯 (직접 추가한 `tools` 포함 — 경로순) */
const MODULES: Module[] = [
  { name: '@acme/ui', path: 'packages/ui', kind: 'npm' },
  { name: 'cart', path: 'src/features/cart', kind: 'npm' },
  { name: 'checkout', path: 'src/features/checkout', kind: 'npm' },
  { name: 'build-tools', path: 'tools', kind: 'manual' },
  { name: '@acme/design-system', path: 'vendor/design-system', kind: 'npm' },
];

/** 서브모듈 하나 */
const sm = (
  path: string,
  status: SubmoduleInfo['status'],
  describe: string | null = null,
): SubmoduleInfo => ({ path, oid: 'a'.repeat(40), status, describe });

/** 목 장면과 같은 서브모듈 다섯 (상태 다섯 가지) */
const SUBMODULES: SubmoduleInfo[] = [
  sm('vendor/design-system', 'clean', 'v2.3.1'),
  sm('vendor/payment-sdk', 'mismatch', 'v1.8.0-4-g1a2b3c4'),
  sm('vendor/analytics', 'dirty', 'v0.9.2'),
  sm('vendor/legacy-theme', 'notInitialized'),
  sm('libs/shared-proto', 'conflict'),
];

const NESTED = [`${ROOT}/experiments`, `${ROOT}/playground`];

/** 작업 트리 변경 하나 */
const entry = (path: string): StatusEntry => ({
  path,
  origPath: null,
  index: 'modified',
  worktree: 'unmodified',
  conflict: null,
  renameScore: null,
});

/** cart 안 넷, checkout 안 하나, 모듈 밖 하나 */
const ENTRIES: StatusEntry[] = [
  entry('src/features/cart/CartSummary.tsx'),
  entry('src/features/cart/hooks/useCartTotals.ts'),
  entry('src/features/cart/__tests__/CartSummary.test.tsx'),
  entry('src/features/cart/CartBadge.tsx'),
  entry('src/features/checkout/steps/PaymentStep.tsx'),
  entry('package.json'),
];

/** 서브모듈 동작 묶음 (세션 액션 자리) */
function fakeSubmoduleActions(busy = false) {
  return {
    busy,
    submoduleUpdateRemote: vi.fn(async () => {}),
    submoduleSetBranch: vi.fn(async () => {}),
    submoduleRemove: vi.fn(async () => {}),
    submoduleAdd: vi.fn(async () => {}),
    submoduleSync: vi.fn(async () => {}),
    submoduleBatch: vi.fn(async () => null),
  } satisfies SubmoduleActions;
}

/** 대화상자: 받은 spec 을 남기고 정한 답을 준다 */
function fakeDialogs(answers: {
  confirm?: boolean;
  prompt?: Record<string, string | boolean> | null;
}) {
  const confirm = vi.fn(async (_spec: unknown) => answers.confirm ?? true);
  const prompt = vi.fn(async (_spec: unknown) => answers.prompt ?? null);
  return { dialogs: { confirm, prompt, element: null } as unknown as Dialogs, confirm, prompt };
}

/** 메뉴를 글자 목록으로: 구분선은 그 앞에 `─`, 꺼짐 ` [disabled]`, 위험 ` [danger]` (기준 파일과 같은 표기) */
function shape(items: readonly MenuItem[]): string[] {
  return items.flatMap((item) => {
    const text = `${item.label}${item.disabled ? ' [disabled]' : ''}${item.danger ? ' [danger]' : ''}`;
    return item.separator ? ['─', text] : [text];
  });
}

/** 비동기 흐름(대화상자 → 동작)이 끝나기를 기다린다 */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** 라벨로 항목을 누른다 */
async function select(items: readonly MenuItem[], label: string) {
  const item = items.find((i) => i.label === label);
  if (!item) {
    throw new Error(`항목 없음: ${label}`);
  }
  item.onSelect?.();
  await settle();
}

describe('서브모듈 행 메뉴 — 옛 사이드바와 같은 4개 (`submoduleItems`, 기준: 브라우저에서 모은 메뉴)', () => {
  it('라벨·순서·구분선·위험 표시: 열기 / update --remote / 추적 branch 지정… / ─ 제거…(위험)', () => {
    const a = fakeSubmoduleActions();
    const { dialogs } = fakeDialogs({});
    expect(shape(submoduleItems(SUBMODULES[0] as SubmoduleInfo, a, dialogs, vi.fn()))).toEqual([
      '열기',
      '추적 브랜치 최신으로 (update --remote)',
      '추적 브랜치 지정…',
      '─',
      '제거… [danger]',
    ]);
  });

  it('꺼짐: 미초기화면 update --remote 만, busy 면 뒤의 셋 (열기는 늘 켜짐)', () => {
    const { dialogs } = fakeDialogs({});
    const uninit = submoduleItems(
      SUBMODULES[3] as SubmoduleInfo,
      fakeSubmoduleActions(),
      dialogs,
      vi.fn(),
    );
    expect(shape(uninit)).toEqual([
      '열기',
      '추적 브랜치 최신으로 (update --remote) [disabled]',
      '추적 브랜치 지정…',
      '─',
      '제거… [danger]',
    ]);
    const busy = submoduleItems(
      SUBMODULES[0] as SubmoduleInfo,
      fakeSubmoduleActions(true),
      dialogs,
      vi.fn(),
    );
    expect(busy.filter((i) => i.disabled).map((i) => i.label)).toEqual([
      S.submodule.updateRemote,
      S.submodule.setBranch,
      S.submodule.remove,
    ]);
  });

  it('열기 = 주입한 열기, update --remote = (경로, merge)', async () => {
    const a = fakeSubmoduleActions();
    const open = vi.fn();
    const items = submoduleItems(SUBMODULES[1] as SubmoduleInfo, a, fakeDialogs({}).dialogs, open);
    await select(items, S.submodule.open);
    expect(open).toHaveBeenCalledTimes(1);
    await select(items, S.submodule.updateRemote);
    expect(a.submoduleUpdateRemote).toHaveBeenCalledWith('vendor/payment-sdk', 'merge');
  });

  it('추적 branch 지정: 대화상자 글자(제목·안내·필드·적용) 그대로, 입력 → (경로, branch), 비우면 null, 취소면 부르지 않는다', async () => {
    const target = SUBMODULES[1] as SubmoduleInfo;
    const a = fakeSubmoduleActions();
    const d = fakeDialogs({ prompt: { branch: 'release/2.0' } });
    await select(submoduleItems(target, a, d.dialogs, vi.fn()), S.submodule.setBranch);
    expect(d.prompt).toHaveBeenCalledWith({
      title: S.submodule.setBranchTitle('vendor/payment-sdk'),
      message: S.submodule.setBranchHint,
      fields: [{ key: 'branch', label: S.submodule.branch }],
      confirmLabel: S.dialog.apply,
    });
    expect(a.submoduleSetBranch).toHaveBeenCalledWith('vendor/payment-sdk', 'release/2.0');
    const empty = fakeDialogs({ prompt: { branch: '' } });
    await select(submoduleItems(target, a, empty.dialogs, vi.fn()), S.submodule.setBranch);
    expect(a.submoduleSetBranch).toHaveBeenLastCalledWith('vendor/payment-sdk', null);
    const cancel = fakeDialogs({ prompt: null });
    await select(submoduleItems(target, a, cancel.dialogs, vi.fn()), S.submodule.setBranch);
    expect(a.submoduleSetBranch).toHaveBeenCalledTimes(2);
  });

  it('제거: 확인창(제목·문구·제거·위험) 그대로, 확인 → (경로), 취소면 부르지 않는다 (되돌리기 어려운 동작)', async () => {
    const target = SUBMODULES[1] as SubmoduleInfo;
    const a = fakeSubmoduleActions();
    const cancel = fakeDialogs({ confirm: false });
    await select(submoduleItems(target, a, cancel.dialogs, vi.fn()), S.submodule.remove);
    expect(cancel.confirm).toHaveBeenCalledWith({
      title: S.submodule.removeTitle('vendor/payment-sdk'),
      message: S.submodule.removeMessage,
      confirmLabel: '제거',
      danger: true,
    });
    expect(a.submoduleRemove).not.toHaveBeenCalled();
    const ok = fakeDialogs({ confirm: true });
    await select(submoduleItems(target, a, ok.dialogs, vi.fn()), S.submodule.remove);
    expect(a.submoduleRemove).toHaveBeenCalledWith('vendor/payment-sdk');
  });
});

describe('서브모듈 머리 동작 (`promptSubmoduleAdd`·`promptSubmoduleBatch` — 옛 머리 단추의 대화상자)', () => {
  it('추가: 제목·필드(URL·경로 필수, branch)·만들기, 인자는 (URL trim, 경로 trim, branch 또는 null). 취소면 부르지 않는다', async () => {
    const a = fakeSubmoduleActions();
    const d = fakeDialogs({
      prompt: { url: ' git@x:acme/ui.git ', path: ' vendor/ui ', branch: '' },
    });
    await promptSubmoduleAdd(a, d.dialogs);
    expect(d.prompt).toHaveBeenCalledWith({
      title: '서브모듈 추가',
      fields: [
        { key: 'url', label: 'URL', required: true },
        { key: 'path', label: '경로', required: true },
        { key: 'branch', label: S.submodule.branch },
      ],
      confirmLabel: S.dialog.create,
    });
    expect(a.submoduleAdd).toHaveBeenCalledWith('git@x:acme/ui.git', 'vendor/ui', null);
    await promptSubmoduleAdd(a, fakeDialogs({ prompt: null }).dialogs);
    expect(a.submoduleAdd).toHaveBeenCalledTimes(1);
  });

  it('일괄: 작업 고르기(기본 fetch)·--prune(기본 켜짐)·실행, 인자는 작업마다 (빈 경로 목록 = 전부). 취소면 부르지 않는다', async () => {
    const a = fakeSubmoduleActions();
    const d = fakeDialogs({ prompt: { op: 'fetch', prune: true } });
    await promptSubmoduleBatch(a, d.dialogs);
    expect(d.prompt).toHaveBeenCalledWith({
      title: '서브모듈 일괄 작업',
      fields: [
        {
          key: 'op',
          label: '작업',
          type: 'select',
          initial: 'fetch',
          options: [
            { value: 'fetch', label: 'fetch' },
            { value: 'pull', label: 'pull' },
            { value: 'push', label: 'push' },
          ],
        },
        { key: 'prune', label: S.submodule.batchPrune, type: 'checkbox', initial: true },
      ],
      confirmLabel: S.dnd.run,
    });
    expect(a.submoduleBatch).toHaveBeenLastCalledWith({ kind: 'fetch', prune: true }, []);
    await promptSubmoduleBatch(a, fakeDialogs({ prompt: { op: 'pull', prune: true } }).dialogs);
    expect(a.submoduleBatch).toHaveBeenLastCalledWith({ kind: 'pull' }, []);
    await promptSubmoduleBatch(a, fakeDialogs({ prompt: { op: 'push', prune: false } }).dialogs);
    expect(a.submoduleBatch).toHaveBeenLastCalledWith({ kind: 'push' }, []);
    await promptSubmoduleBatch(a, fakeDialogs({ prompt: null }).dialogs);
    expect(a.submoduleBatch).toHaveBeenCalledTimes(3);
  });
});

describe('모듈 직접 추가 (`promptModuleAdd` — 옛 모듈 섹션 머리의 ＋)', () => {
  it('제목·필드(경로 필수, 이름)·만들기, 인자는 (이름 trim, 경로 trim). 취소면 부르지 않는다', async () => {
    const add = vi.fn(async () => {});
    const d = fakeDialogs({ prompt: { path: ' apps/admin ', name: ' admin-web ' } });
    await promptModuleAdd(add, d.dialogs);
    expect(d.prompt).toHaveBeenCalledWith({
      title: '모듈 직접 추가',
      fields: [
        { key: 'path', label: '경로', required: true },
        { key: 'name', label: '이름 (비우면 폴더 이름)' },
      ],
      confirmLabel: S.dialog.create,
    });
    expect(add).toHaveBeenCalledWith('admin-web', 'apps/admin');
    await promptModuleAdd(add, fakeDialogs({ prompt: null }).dialogs);
    expect(add).toHaveBeenCalledTimes(1);
  });
});

describe('행 장식 (`repo-structure.ts`)', () => {
  const structure = {
    root: ROOT,
    modules: MODULES,
    scope: null,
    entries: ENTRIES,
    submodules: SUBMODULES,
    nestedRepos: NESTED,
  };

  it('역할: 모듈 다섯·서브모듈 다섯·하위 저장소 둘, vendor/design-system 은 모듈이면서 서브모듈. 루트와 작업 트리 밖은 없다', () => {
    const roles = dirRoles({ ...structure, nestedRepos: [...NESTED, '/elsewhere/repo', ROOT] });
    expect([...roles.keys()].sort()).toEqual(
      [
        'experiments',
        'libs/shared-proto',
        'packages/ui',
        'playground',
        'src/features/cart',
        'src/features/checkout',
        'tools',
        'vendor/analytics',
        'vendor/design-system',
        'vendor/legacy-theme',
        'vendor/payment-sdk',
      ].sort(),
    );
    const both = roles.get('vendor/design-system');
    expect(both?.module?.name).toBe('@acme/design-system');
    expect(both?.submodule?.status).toBe('clean');
    expect(roles.get('experiments')?.nested).toBe(`${ROOT}/experiments`);
  });

  it('모듈: 모듈 아이콘(뜻 "모듈")·보통 굵기, 그 안의 변경 수, 툴팁 `경로 · 종류`(옛 그대로), 이름이 다르면 `[이름]`', () => {
    const decos = repoStructureDecorations(structure);
    expect(decos.get('src/features/cart')).toEqual({
      detail: null,
      icon: 'module',
      iconLabel: S.project.structure.moduleIcon,
      badges: [],
      changed: 4,
      title: 'src/features/cart · npm',
    });
    expect(decos.get('src/features/checkout')?.changed).toBe(1);
    expect(decos.get('packages/ui')).toMatchObject({
      detail: '[@acme/ui]',
      changed: 0,
      title: 'packages/ui · npm',
    });
    expect(decos.get('tools')).toMatchObject({ detail: '[build-tools]', title: 'tools · manual' });
  });

  it('범위: 지금 범위인 모듈만 맨 앞에 "범위" 배지 (옛 "범위" 배지와 같은 글자)', () => {
    const decos = repoStructureDecorations({ ...structure, scope: 'src/features/cart' });
    expect(decos.get('src/features/cart')?.badges).toEqual([
      { tone: 'scope', text: S.modules.scopeBadge },
    ]);
    expect(decos.get('src/features/checkout')?.badges).toEqual([]);
  });

  it('서브모듈: 서브모듈 아이콘·굵은 이름, 상태 문구 + "서브모듈" 배지(폴더 탭 저장소 행과 같은 글자), 툴팁 `경로 (describe)`(옛 그대로) + 상태', () => {
    const decos = repoStructureDecorations(structure);
    expect(decos.get('vendor/payment-sdk')).toEqual({
      detail: null,
      icon: 'submodule',
      bold: true,
      // 상태가 앞이다: 좁은 창에서 행 끝이 잘리면 늘 같은 "서브모듈" 이 먼저 잘린다
      badges: [
        { tone: 'state', text: '커밋 다름' },
        { tone: 'kind', text: S.folder.kind.submodule },
      ],
      title: 'vendor/payment-sdk (v1.8.0-4-g1a2b3c4)\n커밋 다름',
    });
    expect(decos.get('vendor/analytics')?.badges?.[0]).toEqual({
      tone: 'state',
      text: '변경 있음',
    });
    expect(decos.get('vendor/legacy-theme')).toMatchObject({
      badges: [
        { tone: 'state', text: '미초기화' },
        { tone: 'kind', text: '서브모듈' },
      ],
      title: 'vendor/legacy-theme\n미초기화',
    });
    // 충돌은 진행 중 작업처럼 주의 색
    expect(decos.get('libs/shared-proto')?.badges?.[0]).toEqual({ tone: 'op', text: '충돌' });
    // 깨끗하면 상태 배지가 없다 (옛 문구도 빈 글자)
    expect(decos.get('vendor/design-system')?.badges?.filter((b) => b.tone === 'state')).toEqual(
      [],
    );
  });

  it('하위 저장소: 저장소 아이콘(뜻 "하위 저장소")·굵은 이름, 툴팁 = 절대 경로 (옛 그대로)', () => {
    expect(repoStructureDecorations(structure).get('experiments')).toEqual({
      detail: null,
      icon: 'repo',
      iconLabel: S.project.structure.nestedIcon,
      bold: true,
      badges: [],
      title: `${ROOT}/experiments`,
    });
  });

  it('겹침: 서브모듈 > 하위 저장소 > 모듈. 모듈은 덧붙기만 한다 (범위 배지·[이름]·툴팁 한 줄, 변경 수 없음)', () => {
    const scoped = { ...structure, scope: 'vendor/design-system' };
    expect(repoStructureDecorations(scoped).get('vendor/design-system')).toEqual({
      detail: '[@acme/design-system]',
      icon: 'submodule',
      bold: true,
      badges: [
        { tone: 'scope', text: S.modules.scopeBadge },
        { tone: 'kind', text: S.folder.kind.submodule },
      ],
      title: `vendor/design-system (v2.3.1)\n${S.project.structure.moduleLine('@acme/design-system', 'npm')}`,
    });
    const nestedModule = dirDecoration(
      {
        module: { name: 'experiments', path: 'experiments', kind: 'npm' },
        submodule: null,
        nested: `${ROOT}/experiments`,
      },
      { scope: null, entries: [entry('experiments/a.ts')] },
    );
    expect(nestedModule).toMatchObject({ icon: 'repo', detail: null, badges: [] });
    expect(nestedModule?.changed).toBeUndefined();
    expect(nestedModule?.title).toBe(`${ROOT}/experiments\n모듈 experiments · npm`);
    // 서브모듈이면서 하위 저장소 목록에도 있으면(코어는 빼지만) 서브모듈이 이긴다
    expect(
      dirDecoration(
        { module: null, submodule: SUBMODULES[0] as SubmoduleInfo, nested: `${ROOT}/x` },
        { scope: null, entries: [] },
      )?.icon,
    ).toBe('submodule');
    expect(
      dirDecoration({ module: null, submodule: null, nested: null }, { scope: null, entries: [] }),
    ).toBeNull();
  });

  it('루트의 종류: 상위 저장소가 있으면 서브모듈, 연결된 워크트리면 워크트리, 아니면 standalone', () => {
    const main = { path: ROOT, isMain: true };
    expect(rootRepoKind(ROOT, '/mock/platform-monorepo', [main])).toBe('submodule');
    expect(rootRepoKind(ROOT, null, [main, { path: `${ROOT}-hotfix`, isMain: false }])).toBe(
      'standalone',
    );
    expect(
      rootRepoKind(`${ROOT}-hotfix`, null, [main, { path: `${ROOT}-hotfix`, isMain: false }]),
    ).toBe('worktree');
    expect(rootRepoKind(ROOT, null, [])).toBe('standalone');
  });

  it('파일의 저장소를 가를 경로: 작업 트리·하위 저장소·서브모듈 (서브모듈 안 파일에 상위 세션의 히스토리를 걸지 않는다)', () => {
    expect(
      ownerRepoPaths({ root: ROOT, submodules: SUBMODULES.slice(0, 2), nestedRepos: NESTED }),
    ).toEqual([ROOT, ...NESTED, `${ROOT}/vendor/design-system`, `${ROOT}/vendor/payment-sdk`]);
  });
});

/** 트리의 디렉터리 행 */
function dirRow(path: string): EntryRow {
  return {
    kind: 'entry',
    id: path,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    entryKind: 'dir',
    openable: false,
    expandable: true,
    expanded: false,
    size: null,
    mtimeMs: null,
    depth: path.split('/').length,
    parentId: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
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

describe('행 메뉴 (`repoTreeMenu`, W25): 옛 사이드바의 항목이 디렉터리 행 앞에, 일반 항목은 구분선 뒤에 그대로', () => {
  const roles = dirRoles({
    root: ROOT,
    modules: MODULES,
    submodules: SUBMODULES,
    nestedRepos: NESTED,
  });
  /** 메뉴 입력 */
  const input = (
    row: RootRow | EntryRow,
    extra: { scope?: string | null; busy?: boolean; superproject?: string | null } = {},
  ) => ({
    row,
    targets: [row.id],
    root: ROOT,
    isOpenable: () => false,
    fileRepo: () => null,
    roles: (rel: string) => roles.get(rel) ?? null,
    superproject: extra.superproject ?? null,
    scope: extra.scope ?? null,
    busy: extra.busy ?? false,
  });
  /** 동작 묶음. 서브모듈 항목은 진짜 `submoduleItems` 로 만든다 */
  const actions = (busy = false) => {
    const sub = fakeSubmoduleActions(busy);
    const open = vi.fn();
    const act = {
      refresh: vi.fn(),
      openFile: vi.fn(),
      fileHistory: vi.fn(),
      blame: vi.fn(),
      copy: vi.fn(),
      openRepoTab: vi.fn(),
      submoduleItems: (s: SubmoduleInfo) =>
        submoduleItems(s, sub, fakeDialogs({}).dialogs, () => open(`${ROOT}/${s.path}`)),
      selectModule: vi.fn(),
      hideModule: vi.fn(),
    };
    return { act, sub, open };
  };
  const COPY = [S.project.menu.copyPath, S.project.menu.copyRelative];

  it('서브모듈 디렉터리: 옛 메뉴 4개(열기 = 저장소 탭으로 그 경로) ─ 경로 복사 둘', async () => {
    const { act, open } = actions();
    const items = repoTreeMenu(input(dirRow('vendor/payment-sdk')), act);
    expect(shape(items)).toEqual([
      '열기',
      '추적 브랜치 최신으로 (update --remote)',
      '추적 브랜치 지정…',
      '─',
      '제거… [danger]',
      '─',
      ...COPY,
    ]);
    await select(items, S.submodule.open);
    expect(open).toHaveBeenCalledWith(`${ROOT}/vendor/payment-sdk`);
  });

  it('하위 저장소 디렉터리: 저장소 탭으로 열기(폴더 탭의 저장소 행과 같은 글자, 인자 = 절대 경로) ─ 경로 복사 둘', async () => {
    const { act } = actions();
    const items = repoTreeMenu(input(dirRow('experiments')), act);
    expect(shape(items)).toEqual([S.project.openAsTab, '─', ...COPY]);
    await select(items, S.project.openAsTab);
    expect(act.openRepoTab).toHaveBeenCalledWith(`${ROOT}/experiments`);
  });

  it('모듈 디렉터리: 범위가 아니면 "이 모듈만 보기"(busy 면 꺼짐)·숨기기, 범위면 "범위 해제"(꺼지지 않음)·숨기기 ─ 경로 복사', async () => {
    const { act } = actions();
    const plain = repoTreeMenu(input(dirRow('src/features/cart')), act);
    expect(shape(plain)).toEqual([S.modules.scopeTo, S.modules.hide, '─', ...COPY]);
    await select(plain, S.modules.scopeTo);
    expect(act.selectModule).toHaveBeenLastCalledWith('src/features/cart');
    await select(plain, S.modules.hide);
    expect(act.hideModule).toHaveBeenCalledWith('src/features/cart');
    expect(
      shape(repoTreeMenu(input(dirRow('src/features/cart'), { busy: true }), act)).slice(0, 2),
    ).toEqual([`${S.modules.scopeTo} [disabled]`, S.modules.hide]);
    const scoped = repoTreeMenu(
      input(dirRow('src/features/cart'), { scope: 'src/features/cart', busy: true }),
      act,
    );
    expect(shape(scoped)).toEqual([S.modules.clearScope, S.modules.hide, '─', ...COPY]);
    await select(scoped, S.modules.clearScope);
    expect(act.selectModule).toHaveBeenLastCalledWith(null);
  });

  it('겹침: 서브모듈 항목 ─ 모듈 항목 ─ 일반 항목 (사라지는 항목이 없다)', () => {
    const { act } = actions();
    expect(shape(repoTreeMenu(input(dirRow('vendor/design-system')), act))).toEqual([
      '열기',
      '추적 브랜치 최신으로 (update --remote)',
      '추적 브랜치 지정…',
      '─',
      '제거… [danger]',
      '─',
      S.modules.scopeTo,
      S.modules.hide,
      '─',
      ...COPY,
    ]);
  });

  it('역할이 없는 디렉터리는 W21 그대로 (경로 복사 둘)', () => {
    const { act } = actions();
    expect(shape(repoTreeMenu(input(dirRow('src')), act))).toEqual(COPY);
  });

  it('루트: 상위 저장소가 있으면 맨 앞에 옛 링크와 같은 글자 "↑ 상위 저장소 <이름>" (→ 저장소 탭으로 그 경로), 없으면 W21 그대로', async () => {
    const { act } = actions();
    const sub = repoTreeMenu(input(ROOT_ROW, { superproject: '/mock/platform-monorepo' }), act);
    expect(shape(sub)).toEqual([
      '↑ 상위 저장소 platform-monorepo',
      '─',
      S.folder.refresh,
      '─',
      S.project.menu.copyPath,
    ]);
    await select(sub, '↑ 상위 저장소 platform-monorepo');
    expect(act.openRepoTab).toHaveBeenCalledWith('/mock/platform-monorepo');
    expect(shape(repoTreeMenu(input(ROOT_ROW), act))).toEqual([
      S.folder.refresh,
      '─',
      S.project.menu.copyPath,
    ]);
  });

  it('`moduleMenuItems` 는 옛 메뉴의 두 항목(숨기기·범위 해제)을 모두 담는다', () => {
    const act = { selectModule: vi.fn(), hideModule: vi.fn() };
    const labels = (scope: string | null) =>
      moduleMenuItems('tools', { scope, busy: false }, act).map((i) => i.label);
    expect(labels('tools')).toEqual([S.modules.clearScope, S.modules.hide]);
    expect(labels(null)).toEqual([S.modules.scopeTo, S.modules.hide]);
  });
});

describe('머리 메뉴 (`structure-menu.ts`) — 접힌 곳에 있어도 닿게', () => {
  const state = (extra: Partial<StructureMenuState> = {}): StructureMenuState => ({
    root: ROOT,
    modules: MODULES,
    scope: null,
    entries: ENTRIES,
    submodules: SUBMODULES,
    nestedRepos: NESTED,
    busy: false,
    inOp: false,
    ...extra,
  });
  const actions = () => ({
    selectModule: vi.fn(),
    reveal: vi.fn(),
    addModule: vi.fn(),
    reloadModules: vi.fn(),
    addSubmodule: vi.fn(),
    syncSubmodules: vi.fn(),
    batchSubmodules: vi.fn(),
    updateSubmodules: vi.fn(),
  });
  /** 항목을 글자로: 묶음 머리 `# `, 구분선 `─`, 라디오 `( )`·`(•)`, 꺼짐 ` [disabled]` */
  const text = (items: readonly DropdownItem[]): string[] =>
    items.flatMap((item) => {
      switch (item.kind) {
        case 'label':
          return [`# ${item.label}`];
        case 'separator':
          return ['─'];
        case 'radio':
          return item.options.map(
            (o) =>
              `${o.value === item.value ? '(•)' : '( )'} ${o.label}${o.disabled ? ' [disabled]' : ''}`,
          );
        default:
          return [`${item.label}${item.disabled ? ' [disabled]' : ''}`];
      }
    });

  it('보이는 조건: 모듈 묶음 = 모듈이 있거나 범위가 걸림(옛 그대로), 서브모듈·하위 저장소 = 있을 때만, 단추 = 하나라도 있을 때', () => {
    const none = state({ modules: [], submodules: [], nestedRepos: [] });
    expect(showsModules(none)).toBe(false);
    expect(structureMenuShown(none)).toBe(false);
    expect(structureMenuItems(none, actions())).toEqual([]);
    // 범위만 있음 (숨긴 모듈이 범위였던 경우 등): 모듈 묶음이 보이고 "전체" 로 풀 수 있다
    const scopeOnly = state({ modules: [], submodules: [], nestedRepos: [], scope: 'apps/x' });
    expect(structureMenuShown(scopeOnly)).toBe(true);
    expect(text(structureMenuItems(scopeOnly, actions()))).toEqual([
      '# 모듈 0',
      `( ) ${S.modules.all}`,
      S.modules.add,
      S.modules.reload,
    ]);
    expect(text(structureMenuItems(state({ modules: [], nestedRepos: [] }), actions()))[0]).toBe(
      '# 서브모듈 5',
    );
    expect(text(structureMenuItems(state({ modules: [], submodules: [] }), actions()))).toEqual([
      '# 하위 저장소 2',
      'experiments',
      'playground',
    ]);
    expect(structureCounts(state())).toBe('모듈 5 · 서브모듈 5 · 하위 저장소 2');
    expect(structureCounts(state({ modules: [], nestedRepos: [] }))).toBe('서브모듈 5');
  });

  it('항목 전체: 모듈(전체·이름·변경 수·직접 추가·다시 감지) ─ 서브모듈(머리 4동작 ─ 경로·상태) ─ 하위 저장소', () => {
    expect(text(structureMenuItems(state(), actions()))).toEqual([
      '# 모듈 5',
      `(•) ${S.modules.all}`,
      '( ) @acme/ui',
      '( ) cart · 변경 4',
      '( ) checkout · 변경 1',
      '( ) build-tools',
      '( ) @acme/design-system',
      S.modules.add,
      S.modules.reload,
      '─',
      '# 서브모듈 5',
      S.submodule.add,
      S.submodule.sync,
      S.submodule.batch,
      S.submodule.updateRecursive,
      '─',
      'vendor/design-system',
      'vendor/payment-sdk · 커밋 다름',
      'vendor/analytics · 변경 있음',
      'vendor/legacy-theme · 미초기화',
      'libs/shared-proto · 충돌',
      '─',
      '# 하위 저장소 2',
      'experiments',
      'playground',
    ]);
  });

  it('꺼짐: busy 면 모듈(전체는 켜짐)·직접 추가·서브모듈 4동작, 진행 중 작업이면 서브모듈 4동작만 (옛 조건)', () => {
    const busy = text(structureMenuItems(state({ busy: true }), actions()));
    expect(busy.filter((t) => t.endsWith('[disabled]'))).toEqual([
      '( ) @acme/ui [disabled]',
      '( ) cart · 변경 4 [disabled]',
      '( ) checkout · 변경 1 [disabled]',
      '( ) build-tools [disabled]',
      '( ) @acme/design-system [disabled]',
      `${S.modules.add} [disabled]`,
      `${S.submodule.add} [disabled]`,
      `${S.submodule.sync} [disabled]`,
      `${S.submodule.batch} [disabled]`,
      `${S.submodule.updateRecursive} [disabled]`,
    ]);
    const inOp = text(structureMenuItems(state({ inOp: true }), actions()));
    expect(inOp.filter((t) => t.endsWith('[disabled]'))).toEqual([
      `${S.submodule.add} [disabled]`,
      `${S.submodule.sync} [disabled]`,
      `${S.submodule.batch} [disabled]`,
      `${S.submodule.updateRecursive} [disabled]`,
    ]);
  });

  it('모듈 고르기: 범위 토글(옛 행 클릭 — 지금 범위면 풀림) + 트리에서 드러내기, 전체 = 풀기만', () => {
    const radio = (s: StructureMenuState, act: ReturnType<typeof actions>) => {
      const found = structureMenuItems(s, act).find((i) => i.kind === 'radio');
      if (found?.kind !== 'radio') {
        throw new Error('라디오 없음');
      }
      return found;
    };
    const act = actions();
    const r = radio(state(), act);
    // 고르면 메뉴를 닫는다 (트리에서 드러낸 행이 메뉴에 가리지 않게 — 공용 DropdownMenu 의 선택 prop)
    expect(r.closeOnSelect).toBe(true);
    expect(r.value).toBe(ALL_MODULES);
    r.onChange('src/features/cart');
    expect(act.selectModule).toHaveBeenLastCalledWith('src/features/cart');
    expect(act.reveal).toHaveBeenLastCalledWith('src/features/cart');
    const scoped = radio(state({ scope: 'src/features/cart' }), act);
    expect(scoped.value).toBe('src/features/cart');
    scoped.onChange('src/features/cart');
    expect(act.selectModule).toHaveBeenLastCalledWith(null);
    scoped.onChange(ALL_MODULES);
    expect(act.selectModule).toHaveBeenLastCalledWith(null);
    expect(act.reveal).toHaveBeenCalledTimes(2);
  });

  it('이름이 같은 모듈은 경로를 붙여 가른다', () => {
    const twins = state({
      modules: [
        { name: 'api', path: 'clients/api', kind: 'gradle' },
        { name: 'api', path: 'services/api', kind: 'gradle' },
      ],
      submodules: [],
      nestedRepos: [],
    });
    expect(text(structureMenuItems(twins, actions())).slice(2, 4)).toEqual([
      '( ) api (clients/api)',
      '( ) api (services/api)',
    ]);
  });

  it('머리 동작과 목록: 직접 추가·다시 감지·서브모듈 4동작은 주입한 동작, 서브모듈·하위 저장소 항목은 트리에서 드러내기', () => {
    const act = actions();
    const items = structureMenuItems(state(), act);
    const press = (label: string) => {
      const item = items.find((i) => i.kind === 'item' && i.label === label);
      if (item?.kind !== 'item') {
        throw new Error(`항목 없음: ${label}`);
      }
      item.onSelect();
    };
    press(S.modules.add);
    press(S.modules.reload);
    press(S.submodule.add);
    press(S.submodule.sync);
    press(S.submodule.batch);
    press(S.submodule.updateRecursive);
    for (const fn of [
      act.addModule,
      act.reloadModules,
      act.addSubmodule,
      act.syncSubmodules,
      act.batchSubmodules,
      act.updateSubmodules,
    ]) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    press('vendor/legacy-theme · 미초기화');
    expect(act.reveal).toHaveBeenLastCalledWith('vendor/legacy-theme');
    press('playground');
    expect(act.reveal).toHaveBeenLastCalledWith('playground');
  });
});
