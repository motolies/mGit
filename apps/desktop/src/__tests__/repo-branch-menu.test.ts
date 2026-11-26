// W22: 저장소 탭 브랜치 트리의 메뉴·더블클릭·머리 단추 (`repo-branch-menu.ts`) — 옛 사이드바(`Sidebar.tsx`)의 다섯 섹션
// 메뉴를 옮긴 것이 옛 것과 같은지 대조한다 (계획 7.2절 "테스트 이전": 메뉴 라벨 대조 테스트).
// - 라벨·순서·구분선·하위 메뉴·꺼짐·위험 표시: 손대기 전 브라우저에서 모은 옛 메뉴(스크래치패드 `w22/baseline-old-sidebar.json`,
//   저장소 장면)를 글자 그대로 기대값으로 쓴다.
// - 누르면 부르는 세션 동작과 인자, 확인·입력 대화상자의 제목·문구·위험 표시: 옛 `Sidebar.tsx` 의 코드와 같은 값.

import type { BackupRef, GraphQuery, RefLabel, WorktreeInfo, WorktreeRemoveCheck } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../components/ContextMenu';
import { branchNameField } from '../features/branch/branch-name';
import {
  openRepoBranch,
  type RepoBranchDeps,
  type RepoBranchMenuState,
  type RepoBranchSession,
  repoBranchMenu,
  repoBranchRowActions,
  repoFocusRevs,
} from '../features/branches/repo-branch-menu';
import { REPO_GROUP_IDS, type RepoBranchTarget } from '../features/branches/repo-branch-tree';
import { DEFAULT_GRAPH_QUERY } from '../store/session-store';

const PATH = '/mock/storefront-web';
const OID = 'c0ffee'.padEnd(40, '0');

/** 로컬 브랜치 라벨 */
function local(name: string, extra: Partial<RefLabel> = {}): RefLabel {
  return {
    fullName: `refs/heads/${name}`,
    shortName: name,
    kind: { kind: 'localBranch' },
    target: OID,
    isCurrent: false,
    upstream: `origin/${name}`,
    upstreamGone: false,
    ...extra,
  };
}

const remoteLabel = (remote: string, name: string): RefLabel => ({
  fullName: `refs/remotes/${remote}/${name}`,
  shortName: `${remote}/${name}`,
  kind: { kind: 'remoteBranch', remote },
  target: OID,
  isCurrent: false,
  upstreamGone: false,
});

const tagLabel = (name: string): RefLabel => ({
  fullName: `refs/tags/${name}`,
  shortName: name,
  kind: { kind: 'tag', annotated: true },
  target: OID,
  isCurrent: false,
  upstreamGone: false,
});

function wt(path: string, extra: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    path,
    head: OID,
    branch: null,
    detached: false,
    bare: false,
    locked: null,
    prunable: null,
    isMain: false,
    ...extra,
  };
}

const backup = (branch: string): BackupRef => ({
  name: `refs/mgit/backup/${branch}/1761590000-000001`,
  branch,
  oid: OID,
  createdAt: 1_761_590_000,
});

// 저장소 장면의 대상들 (옛 메뉴를 모은 행)
const T = {
  development: { kind: 'local', label: local('development') },
  main: { kind: 'local', label: local('main', { isCurrent: true }) },
  searchFilters: { kind: 'local', label: local('feature/search-filters', { upstream: null }) },
  hotfix: {
    kind: 'local',
    label: local('hotfix/payment-timeout', { worktreePath: `${PATH}-hotfix` }),
  },
  origin: { kind: 'remoteGroup', remote: 'origin' },
  originMain: { kind: 'remote', label: remoteLabel('origin', 'main'), remote: 'origin' },
  tag: { kind: 'tag', label: tagLabel('v2.4.0') },
  wtMain: { kind: 'worktree', worktree: wt(PATH, { branch: 'main', isMain: true }) },
  wtOther: {
    kind: 'worktree',
    worktree: wt(`${PATH}-hotfix`, { branch: 'hotfix/payment-timeout' }),
  },
  wtLocked: { kind: 'worktree', worktree: wt(`${PATH}-review`, { locked: '코드 리뷰 중' }) },
  wtPrunable: { kind: 'worktree', worktree: wt(`${PATH}-gone`, { prunable: 'gone' }) },
  backupMain: { kind: 'backup', backup: backup('main') },
  backupStaging: { kind: 'backup', backup: backup('staging') },
  wtGroup: { kind: 'worktreeGroup' },
} satisfies Record<string, RepoBranchTarget>;

const GRAPH_QUERY: GraphQuery = { ...DEFAULT_GRAPH_QUERY, firstParent: true };

/** 워크트리 삭제 전 검사 결과 (hotfix 워크트리) */
const removeCheck = (extra: Partial<WorktreeRemoveCheck>): WorktreeRemoveCheck => ({
  path: `${PATH}-hotfix`,
  branch: null,
  dirty: false,
  unpushed: null,
  isMain: false,
  ...extra,
});

/** 세션 동작 흉내: 모두 vi.fn. 값을 돌려주는 것만 정한다 */
function fakeSession(check: WorktreeRemoveCheck | null = null) {
  return {
    checkout: vi.fn(async () => {}),
    setGraphQuery: vi.fn(async () => {}),
    openCompare: vi.fn(async () => {}),
    merge: vi.fn(async () => {}),
    openMergePreview: vi.fn(async () => {}),
    openRebasePreview: vi.fn(async () => {}),
    isolatedMerge: vi.fn(async () => '/mock/storefront-web.worktrees/_merge-1'),
    rebase: vi.fn(async () => {}),
    renameBranch: vi.fn(async () => {}),
    setUpstream: vi.fn(async () => {}),
    updateBranch: vi.fn(async () => {}),
    deleteBranch: vi.fn(async () => {}),
    fetch: vi.fn(async () => {}),
    push: vi.fn(async () => true),
    deleteRemoteBranch: vi.fn(async () => {}),
    pushTags: vi.fn(async () => []),
    deleteTagsScoped: vi.fn(async () => undefined),
    checkRemoteTags: vi.fn(async () => {}),
    backupRestore: vi.fn(async () => {}),
    backupDelete: vi.fn(async () => {}),
    worktreeRemoveCheck: vi.fn(async () => check),
    worktreeRemove: vi.fn(async () => {}),
    worktreeLock: vi.fn(async () => {}),
    worktreeUnlock: vi.fn(async () => {}),
    worktreePrune: vi.fn(async () => {}),
    suggestWorktreePath: vi.fn(async (name: string) => `/mock/wt/${name}`),
    worktreeAdd: vi.fn(async (path: string) => path),
  } satisfies RepoBranchSession;
}

/** 동작 묶음을 만든다. 대화상자는 받은 spec 을 남기고 정한 답을 준다 */
function setup(
  state: Partial<RepoBranchMenuState> = {},
  answers: {
    confirm?: boolean;
    prompt?: Record<string, string | boolean> | null;
    check?: WorktreeRemoveCheck | null;
    choice?: 'confirm' | 'secondary' | 'cancel';
  } = {},
) {
  const session = fakeSession(answers.check ?? null);
  const confirm = vi.fn(async (_spec: unknown) => answers.confirm ?? true);
  const confirmChoice = vi.fn(async (_spec: unknown) => answers.choice ?? 'cancel');
  const prompt = vi.fn(async (_spec: unknown) => answers.prompt ?? null);
  const openRepositoryAt = vi.fn(async () => 9);
  const copyText = vi.fn();
  const openTagsDoc = vi.fn();
  const deps: RepoBranchDeps = {
    deleteRemoteWithLocals: vi.fn(async () => {}),
    state: {
      id: 3,
      path: PATH,
      busy: false,
      inOp: false,
      headBranch: 'main',
      isolatedBranch: null,
      graphQuery: GRAPH_QUERY,
      prunable: 0,
      remotes: ['origin'],
      tagReports: {},
      tagChecking: false,
      ...state,
    },
    session,
    dialogs: { confirm, confirmChoice, prompt },
    openRepositoryAt,
    copyText,
    openTagsDoc,
  };
  return {
    deps,
    session,
    confirm,
    confirmChoice,
    prompt,
    openRepositoryAt,
    copyText,
    openTagsDoc,
  };
}

/**
 * 메뉴를 옛 메뉴를 모은 모양의 글자 목록으로: 구분선은 그 앞에 `---`, 꺼짐 ` [off]`, 위험 ` [danger]`,
 * 하위 메뉴 `▸ {…}` (하위 메뉴가 꺼져 있으면 옛 화면에서 열 수 없었으므로 `▸` 만)
 */
function shape(items: readonly MenuItem[]): string[] {
  return items.flatMap((item) => {
    const sub = item.children
      ? item.disabled
        ? '▸'
        : `▸ {${item.children.map((c) => c.label).join(', ')}}`
      : '';
    const text = `${item.label}${sub}${item.disabled ? ' [off]' : ''}${item.danger ? ' [danger]' : ''}`;
    return item.separator ? ['---', text] : [text];
  });
}

/** 라벨로 항목을 찾는다 (하위 메뉴까지) */
function itemOf(items: readonly MenuItem[], label: string): MenuItem {
  const all = items.flatMap((i) => [i, ...(i.children ?? [])]);
  const found = all.find((i) => i.label === label);
  if (!found) {
    throw new Error(`항목 없음: ${label}`);
  }
  return found;
}

/** 항목을 누르고 비동기 흐름(대화상자 → 동작)이 끝나기를 기다린다 */
async function select(items: readonly MenuItem[], label: string) {
  itemOf(items, label).onSelect?.();
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** 꺼진 항목의 라벨 */
const offLabels = (items: readonly MenuItem[]) =>
  items.filter((i) => i.disabled).map((i) => i.label);

describe('옛 사이드바 메뉴와 같은 항목 (라벨·순서·구분선·하위 메뉴·꺼짐 — 손대기 전 화면에서 모은 그대로)', () => {
  const menu = (target: RepoBranchTarget, state: Partial<RepoBranchMenuState> = {}) =>
    shape(repoBranchMenu(target, setup(state).deps));
  const MERGE_SUB = `▸ {merge, ${S.menu.mergeIntoNoFf}, ${S.menu.mergeIntoFfOnly}, ${S.menu.mergeIntoSquash}}`;

  it('로컬 (현재가 아닌 branch, 업스트림 있음) — 13개 (옛 12개 + checkout 다음의 업데이트, BR-09)', () => {
    const items = repoBranchMenu(T.development, setup().deps);
    expect(items).toHaveLength(15);
    expect(shape(items)).toEqual([
      '브랜치 전환',
      '업스트림과 비교',
      '업데이트',
      '이 브랜치만 그래프에 표시',
      '현재 로컬 내용과 비교',
      '현재 브랜치와 development 비교…',
      `${S.menu.mergeInto('development')}${MERGE_SUB}`,
      'development 병합 미리보기…',
      'development 위로 리베이스 예측…',
      'development 격리 병합…',
      '현재 브랜치를 development 위로 리베이스',
      '---',
      '이름 변경…',
      '업스트림 해제',
      '삭제… [danger]',
      '---',
      '이름 복사',
    ]);
  });

  it('로컬 (현재 branch main) — checkout·비교·merge·미리보기·격리 병합·rebase·삭제가 꺼진다', () => {
    expect(menu(T.main)).toEqual([
      '브랜치 전환 [off]',
      // 현재 branch 도 업데이트할 수 있다 (작업 트리까지 fast-forward)
      '업스트림과 비교',
      '업데이트',
      '이 브랜치만 그래프에 표시',
      '현재 로컬 내용과 비교',
      '현재 브랜치와 main 비교… [off]',
      `${S.menu.mergeInto('main')}▸ [off]`,
      'main 병합 미리보기… [off]',
      'main 위로 리베이스 예측… [off]',
      'main 격리 병합… [off]',
      '현재 브랜치를 main 위로 리베이스 [off]',
      '---',
      '이름 변경…',
      '업스트림 해제',
      '삭제… [off] [danger]',
      '---',
      '이름 복사',
    ]);
  });

  it('로컬 (업스트림 없음) 은 "업스트림 지정…"·업데이트 꺼짐, 다른 워크트리에 체크아웃된 branch 는 업데이트만 꺼진다', () => {
    expect(menu(T.searchFilters)[2]).toBe('업데이트 [off]');
    expect(menu(T.searchFilters)[13]).toBe('업스트림 지정…');
    expect(menu(T.hotfix)).toEqual(
      menu(T.development).map((l) =>
        l === '업데이트' ? '업데이트 [off]' : l.replaceAll('development', 'hotfix/payment-timeout'),
      ),
    );
  });

  it('원격 이름 그룹 (origin) — 4개', () => {
    const items = repoBranchMenu(T.origin, setup().deps);
    expect(items).toHaveLength(4);
    expect(shape(items)).toEqual([
      S.remote.fetchOnly('origin'),
      'origin로 푸시',
      'origin로 푸시하고 업스트림 지정',
      '---',
      '이름 복사',
    ]);
  });

  it('원격 branch (origin/main) — 7개', () => {
    const items = repoBranchMenu(T.originMain, setup().deps);
    expect(items).toHaveLength(8);
    expect(shape(items)).toEqual([
      '브랜치 전환',
      '이 브랜치만 그래프에 표시',
      '현재 로컬 내용과 비교',
      '현재 브랜치와 origin/main 비교…',
      'origin/main → 현재 브랜치 병합',
      '현재 브랜치를 origin/main 위로 리베이스',
      '---',
      `${S.menu.deleteRemote} [danger]`,
      '---',
      '이름 복사',
    ]);
  });

  it('태그 — 4개: checkout · ── push(원격 하나면 평면) · 삭제 · ── 이름 복사 (TG-01 ①)', () => {
    const items = repoBranchMenu(T.tag, setup().deps);
    expect(items).toHaveLength(4);
    expect(shape(items)).toEqual([
      '이 커밋으로 전환 (분리된 HEAD)',
      '---',
      S.remote.pushTo('origin'),
      '삭제… [danger]',
      '---',
      '이름 복사',
    ]);
  });

  it('태그 push: 원격이 없으면 꺼진 항목, 둘 이상이면 원격 이름 하위 메뉴', () => {
    expect(menu(T.tag, { remotes: [] })).toEqual([
      '이 커밋으로 전환 (분리된 HEAD)',
      '---',
      `${S.tag.pushNoRemote} [off]`,
      '삭제… [danger]',
      '---',
      '이름 복사',
    ]);
    expect(menu(T.tag, { remotes: ['origin', 'upstream'] })[2]).toBe(
      `${S.tag.pushMenu}▸ {origin, upstream}`,
    );
  });

  it('워크트리 — 4개: 이 탭(main)·다른 것·잠긴 것·폴더 없는 것', () => {
    expect(repoBranchMenu(T.wtMain, setup().deps)).toHaveLength(4);
    expect(menu(T.wtMain)).toEqual([
      '열기 [off]',
      '---',
      '삭제… [off] [danger]',
      '잠금… [off]',
      '사라진 워크트리 정리',
    ]);
    expect(menu(T.wtOther)).toEqual([
      '열기',
      '---',
      '삭제… [danger]',
      '잠금…',
      '사라진 워크트리 정리',
    ]);
    expect(menu(T.wtLocked)).toEqual([
      '열기',
      '---',
      '삭제… [danger]',
      '잠금 해제',
      '사라진 워크트리 정리',
    ]);
    expect(menu(T.wtPrunable)).toEqual(menu(T.wtOther));
  });

  it('백업 — 3개: 현재 branch 의 백업도 다른 branch 의 백업도 항목은 같다', () => {
    expect(repoBranchMenu(T.backupMain, setup().deps)).toHaveLength(3);
    expect(menu(T.backupMain)).toEqual([
      '새 브랜치로 복원…',
      'main 를 이 시점으로 되돌리기',
      '---',
      '백업 삭제 [danger]',
    ]);
    expect(menu(T.backupStaging)).toEqual([
      '새 브랜치로 복원…',
      'staging 를 이 시점으로 되돌리기',
      '---',
      '백업 삭제 [danger]',
    ]);
  });

  it('HEAD 행에는 메뉴가 없다 (폴더 트리와 같다). Worktrees 그룹 메뉴는 머리 단추와 같은 두 동작이다', () => {
    expect(repoBranchMenu({ kind: 'head', oid: OID }, setup().deps)).toEqual([]);
    expect(menu(T.wtGroup)).toEqual([S.worktree.create, S.worktree.prune]);
    expect(menu(T.wtGroup, { busy: true })).toEqual([
      `${S.worktree.create} [off]`,
      `${S.worktree.prune} [off]`,
    ]);
  });
});

describe('꺼짐 조건 (옛 사이드바의 `disabled = busy || op !== null` 과 `busy` 의 구분)', () => {
  const off = (target: RepoBranchTarget, state: Partial<RepoBranchMenuState>) =>
    offLabels(repoBranchMenu(target, setup(state).deps));
  const name = 'development';
  const writes = [
    S.menu.checkout,
    S.menu.compareWithHead(name),
    S.menu.mergeInto(name),
    S.menu.mergePreview(name),
    S.menu.rebasePreview(name),
    S.menu.isolatedMerge(name),
    S.menu.rebaseCurrentOnto(name),
  ];

  it('로컬: 다른 작업 실행 중이면 그래프 표시·이름 복사 말고 모두 꺼진다', () => {
    expect(off(T.development, { busy: true })).toEqual([
      writes[0],
      S.branches.menu.update,
      ...writes.slice(1),
      S.menu.rename,
      S.menu.unsetUpstream,
      S.menu.delete,
    ]);
  });

  it('로컬: 진행 중 작업(merge·rebase 등)이 있으면 쓰기 동작만 꺼지고 이름 변경·업스트림·삭제는 켜져 있다', () => {
    expect(off(T.development, { inOp: true })).toEqual(writes);
  });

  it('로컬 업데이트 (BR-09): 현재 branch 는 진행 중 작업이면, 업스트림이 사라졌으면 꺼진다 (checkout 안 한 branch 는 진행 중이어도 켜짐)', () => {
    expect(off(T.main, { inOp: true })).toContain(S.branches.menu.update);
    expect(off(T.development, { inOp: true })).not.toContain(S.branches.menu.update);
    const gone = { kind: 'local', label: local('old', { upstreamGone: true }) } as const;
    expect(off(gone, {})).toContain(S.branches.menu.update);
  });

  it('로컬: 분리 HEAD(현재 branch 없음)면 HEAD 와 견주는 동작만 꺼진다. 격리 병합 중이면 격리 병합만 꺼진다', () => {
    expect(off(T.development, { headBranch: null })).toEqual(writes.slice(1));
    expect(off(T.development, { isolatedBranch: 'mgit/isolated-1' })).toEqual([
      S.menu.isolatedMerge(name),
    ]);
  });

  it('원격 이름 그룹: 현재 branch 가 없으면 push 둘만, 진행 중 작업이면 fetch 까지 꺼진다', () => {
    expect(off(T.origin, { headBranch: null })).toEqual([
      S.remote.pushTo('origin'),
      S.remote.pushToSetUpstream('origin'),
    ]);
    expect(off(T.origin, { inOp: true })).toEqual([
      S.remote.fetchOnly('origin'),
      S.remote.pushTo('origin'),
      S.remote.pushToSetUpstream('origin'),
    ]);
  });

  it('원격 branch: 진행 중 작업이면 checkout·비교·merge·rebase, 실행 중이면 원격 삭제까지. 현재 branch 가 없으면 비교·merge·rebase', () => {
    const short = 'origin/main';
    const writesR = [
      S.menu.checkout,
      S.menu.compareWithHead(short),
      S.menu.mergeInto(short),
      S.menu.rebaseCurrentOnto(short),
    ];
    expect(off(T.originMain, { inOp: true })).toEqual(writesR);
    expect(off(T.originMain, { busy: true })).toEqual([...writesR, S.menu.deleteRemote]);
    expect(off(T.originMain, { headBranch: null })).toEqual(writesR.slice(1));
  });

  it('태그: 진행 중 작업이면 checkout 만, 실행 중이면 push·삭제까지 꺼진다 (push 는 busy 만 본다, D16)', () => {
    expect(off(T.tag, { inOp: true })).toEqual([S.menu.checkoutDetached]);
    expect(off(T.tag, { busy: true })).toEqual([
      S.menu.checkoutDetached,
      S.remote.pushTo('origin'),
      S.menu.delete,
    ]);
    expect(
      offLabels(repoBranchMenu(T.tag, setup({ busy: true, remotes: ['origin', 'upstream'] }).deps)),
    ).toEqual([S.menu.checkoutDetached, S.tag.pushMenu, S.menu.delete]);
  });

  it('워크트리·백업: 실행 중이면 쓰기 항목이 모두 꺼진다 (진행 중 작업과는 무관)', () => {
    expect(off(T.wtOther, { inOp: true })).toEqual([]);
    expect(off(T.wtOther, { busy: true })).toEqual([
      S.worktree.remove,
      S.safety.lock,
      S.worktree.prune,
    ]);
    expect(off(T.wtLocked, { busy: true })).toEqual([
      S.worktree.remove,
      S.safety.unlock,
      S.worktree.prune,
    ]);
    expect(off(T.backupStaging, { inOp: true })).toEqual([]);
    expect(off(T.backupStaging, { busy: true })).toEqual([
      S.safety.restoreAsBranch,
      S.safety.restoreBranch('staging'),
      S.safety.deleteBackup,
    ]);
  });
});

describe('누르면 부르는 세션 동작과 확인·입력 대화상자 (옛 사이드바와 같은 인자·문구)', () => {
  it('로컬: checkout·그래프 표시·비교·merge 4종·미리보기 2종·rebase·업스트림 해제·이름 복사는 대화상자 없이 바로 부른다', async () => {
    const { deps, session, confirm, prompt, copyText } = setup();
    const items = repoBranchMenu(T.development, deps);
    const n = 'development';
    await select(items, S.menu.checkout);
    expect(session.checkout).toHaveBeenCalledWith({ kind: 'branch', name: n });
    await select(items, S.branches.menu.update);
    expect(session.updateBranch).toHaveBeenCalledWith(n);
    await select(items, S.menu.graphSolo);
    expect(session.setGraphQuery).toHaveBeenCalledWith({
      ...GRAPH_QUERY,
      revs: { kind: 'solo', name: n },
    });
    await select(items, S.menu.compareWithHead(n));
    expect(session.openCompare).toHaveBeenCalledWith('main', n, false);
    for (const [label, mode] of [
      ['merge', 'default'],
      [S.menu.mergeIntoNoFf, 'noFf'],
      [S.menu.mergeIntoFfOnly, 'ffOnly'],
      [S.menu.mergeIntoSquash, 'squash'],
    ] as const) {
      await select(items, label);
      expect(session.merge).toHaveBeenLastCalledWith(n, mode);
    }
    expect(session.merge).toHaveBeenCalledTimes(4);
    await select(items, S.menu.mergePreview(n));
    expect(session.openMergePreview).toHaveBeenCalledWith(n);
    await select(items, S.menu.rebasePreview(n));
    expect(session.openRebasePreview).toHaveBeenCalledWith(n);
    // rebase 는 옛 메뉴처럼 확인 없이 autostash 로 바로 부른다
    await select(items, S.menu.rebaseCurrentOnto(n));
    expect(session.rebase).toHaveBeenCalledWith(n, true);
    await select(items, S.menu.unsetUpstream);
    expect(session.setUpstream).toHaveBeenCalledWith(n, null);
    await select(items, S.menu.copyName);
    expect(copyText).toHaveBeenCalledWith(n);
    expect(confirm).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it('로컬 삭제: 위험 확인창(제목·문구·삭제)을 거쳐 강제 아님으로 지운다. 취소하면 지우지 않는다', async () => {
    const no = setup({}, { confirm: false });
    await select(repoBranchMenu(T.development, no.deps), S.menu.delete);
    expect(no.confirm).toHaveBeenCalledWith({
      title: S.dialog.deleteBranch('development'),
      message: S.dialog.deleteBranchMessage,
      confirmLabel: S.dialog.delete,
      danger: true,
    });
    expect(no.session.deleteBranch).not.toHaveBeenCalled();
    const yes = setup({}, { confirm: true });
    await select(repoBranchMenu(T.development, yes.deps), S.menu.delete);
    expect(yes.session.deleteBranch).toHaveBeenCalledWith('development', false);
  });

  it('로컬 이름 변경·업스트림 지정: 입력 대화상자(기본값 포함)를 거친다', async () => {
    const r = setup({}, { prompt: { name: 'renamed' } });
    await select(repoBranchMenu(T.development, r.deps), S.menu.rename);
    expect(r.prompt).toHaveBeenCalledWith({
      title: S.dialog.renameBranch,
      // 새 이름 칸은 지금 이름으로 채우고 정규화한다 (미리보기 "바꿀 이름")
      fields: [
        branchNameField(
          { key: 'name', label: S.dialog.newName, initial: 'development', required: true },
          'rename',
        ),
      ],
      confirmLabel: S.dialog.rename,
    });
    expect(r.session.renameBranch).toHaveBeenCalledWith('development', 'renamed');
    const u = setup({}, { prompt: { up: 'upstream/feature/search-filters' } });
    await select(repoBranchMenu(T.searchFilters, u.deps), S.menu.setUpstream);
    expect(u.prompt).toHaveBeenCalledWith({
      title: S.dialog.setUpstream,
      fields: [
        {
          key: 'up',
          label: S.dialog.upstreamName,
          initial: 'origin/feature/search-filters',
          required: true,
        },
      ],
      confirmLabel: S.dialog.apply,
    });
    expect(u.session.setUpstream).toHaveBeenCalledWith(
      'feature/search-filters',
      'upstream/feature/search-filters',
    );
    // 취소하면 부르지 않는다
    const c = setup({}, { prompt: null });
    await select(repoBranchMenu(T.development, c.deps), S.menu.rename);
    expect(c.session.renameBranch).not.toHaveBeenCalled();
  });

  it('격리 병합: 확인(위험 아님) → 임시 워크트리에서 merge → 그 워크트리를 이 탭의 하위 탭으로 연다. 취소하면 아무것도 안 한다', async () => {
    const no = setup({}, { confirm: false });
    await select(repoBranchMenu(T.development, no.deps), S.menu.isolatedMerge('development'));
    expect(no.confirm).toHaveBeenCalledWith({
      title: S.preview.isolatedTitle,
      message: S.preview.isolatedConfirm('development'),
      confirmLabel: S.preview.isolatedStart,
    });
    expect(no.session.isolatedMerge).not.toHaveBeenCalled();
    const yes = setup();
    await select(repoBranchMenu(T.development, yes.deps), S.menu.isolatedMerge('development'));
    expect(yes.session.isolatedMerge).toHaveBeenCalledWith('development', 'default');
    expect(yes.openRepositoryAt).toHaveBeenCalledWith('/mock/storefront-web.worktrees/_merge-1', 3);
  });

  it('원격 이름 그룹: 이 원격만 fetch(prune), 이 원격으로 push, push + 업스트림 지정, 이름 복사', async () => {
    const { deps, session, copyText } = setup();
    const items = repoBranchMenu(T.origin, deps);
    await select(items, S.remote.fetchOnly('origin'));
    expect(session.fetch).toHaveBeenCalledWith('origin', true);
    await select(items, S.remote.pushTo('origin'));
    expect(session.push).toHaveBeenLastCalledWith({ remote: 'origin' });
    await select(items, S.remote.pushToSetUpstream('origin'));
    expect(session.push).toHaveBeenLastCalledWith({ remote: 'origin', setUpstream: true });
    await select(items, S.menu.copyName);
    expect(copyText).toHaveBeenCalledWith('origin');
  });

  it('원격 branch: checkout 은 (원격, branch) 로, 표시·비교·merge·rebase·복사는 origin/x 로. 원격 삭제는 위험 확인 뒤', async () => {
    const { deps, session, copyText } = setup();
    const items = repoBranchMenu(T.originMain, deps);
    await select(items, S.menu.checkout);
    expect(session.checkout).toHaveBeenCalledWith({
      kind: 'remoteBranch',
      remote: 'origin',
      name: 'main',
    });
    await select(items, S.menu.graphSolo);
    expect(session.setGraphQuery).toHaveBeenCalledWith({
      ...GRAPH_QUERY,
      revs: { kind: 'solo', name: 'origin/main' },
    });
    await select(items, S.menu.compareWithHead('origin/main'));
    expect(session.openCompare).toHaveBeenCalledWith('main', 'origin/main', false);
    await select(items, S.menu.mergeInto('origin/main'));
    expect(session.merge).toHaveBeenCalledWith('origin/main', 'default');
    await select(items, S.menu.rebaseCurrentOnto('origin/main'));
    expect(session.rebase).toHaveBeenCalledWith('origin/main', true);
    await select(items, S.menu.deleteRemote);
    expect(deps.deleteRemoteWithLocals).toHaveBeenCalledWith('origin', 'main');
    expect(session.deleteRemoteBranch).not.toHaveBeenCalled();
    await select(items, S.menu.copyName);
    expect(copyText).toHaveBeenCalledWith('origin/main');
  });

  it('태그: 그 커밋으로 분리 checkout, 원격으로 push, 이름 복사', async () => {
    const { deps, session, copyText } = setup();
    const items = repoBranchMenu(T.tag, deps);
    await select(items, S.menu.checkoutDetached);
    expect(session.checkout).toHaveBeenCalledWith({ kind: 'commit', oid: OID });
    await select(items, S.remote.pushTo('origin'));
    expect(session.pushTags).toHaveBeenCalledWith('origin', ['v2.4.0']);
    await select(items, S.menu.copyName);
    expect(copyText).toHaveBeenCalledWith('v2.4.0');
  });

  it('태그 삭제: 원격이 없으면 위험 확인에 되돌리기 안내 뒤 로컬만 (TG-03 ⑤)', async () => {
    const { deps, session, confirm } = setup({ remotes: [] });
    await select(repoBranchMenu(T.tag, deps), S.menu.delete);
    expect(confirm).toHaveBeenCalledWith({
      title: S.dialog.deleteTag('v2.4.0'),
      message: S.tag.del.localUndo,
      items: undefined,
      confirmLabel: S.dialog.delete,
      danger: true,
    });
    expect(session.deleteTagsScoped).toHaveBeenCalledWith(
      ['v2.4.0'],
      { local: true, remotes: [] },
      { silent: undefined },
    );
  });

  it('태그 삭제: 원격이 있으면 지울 곳 대화상자(위험, 로컬만 기본) 뒤 고른 곳으로 (TG-03 ①~③)', async () => {
    const { deps, session, prompt } = setup(
      { remotes: ['origin', 'upstream'] },
      { prompt: { local: true, remote0: false, remote1: true } },
    );
    await select(repoBranchMenu(T.tag, deps), S.menu.delete);
    const spec = prompt.mock.calls[0]?.[0] as {
      title: string;
      danger: boolean;
      items?: readonly string[];
      fields: { key: string; initial: boolean; group: string }[];
    };
    expect(spec.title).toBe(S.tag.del.title('v2.4.0'));
    expect(spec.danger).toBe(true);
    expect(spec.items).toBeUndefined();
    expect(spec.fields.map((f) => [f.key, f.initial, f.group])).toEqual([
      ['local', true, S.tag.del.scope],
      ['remote0', false, S.tag.del.scope],
      ['remote1', false, S.tag.del.scope],
    ]);
    expect(session.deleteTagsScoped).toHaveBeenCalledWith(
      ['v2.4.0'],
      { local: true, remotes: ['upstream'] },
      expect.objectContaining({ onDiverged: expect.any(Function) }),
    );
  });

  it('워크트리: 열기(탭으로), 잠금(이유 입력, 비우면 null)·잠금 해제, 정리', async () => {
    const { deps, session, prompt, openRepositoryAt } = setup({}, { prompt: { reason: '' } });
    await select(repoBranchMenu(T.wtOther, deps), S.worktree.open);
    expect(openRepositoryAt).toHaveBeenCalledWith(`${PATH}-hotfix`);
    await select(repoBranchMenu(T.wtOther, deps), S.safety.lock);
    expect(prompt).toHaveBeenCalledWith({
      title: S.safety.lockTitle,
      fields: [{ key: 'reason', label: S.safety.lockReason }],
      confirmLabel: S.dialog.apply,
    });
    expect(session.worktreeLock).toHaveBeenCalledWith(`${PATH}-hotfix`, null);
    await select(repoBranchMenu(T.wtLocked, deps), S.safety.unlock);
    expect(session.worktreeUnlock).toHaveBeenCalledWith(`${PATH}-review`);
    await select(repoBranchMenu(T.wtOther, deps), S.worktree.prune);
    expect(session.worktreePrune).toHaveBeenCalledTimes(1);
  });

  it('워크트리 삭제: 검사 결과를 문구로 보이고(변경·push 안 한 commit·업스트림 없음·깨끗함) branch 도 지울지 묻는다', async () => {
    const dirty = setup(
      {},
      {
        check: removeCheck({ dirty: true, unpushed: null, branch: 'hotfix/payment-timeout' }),
        prompt: { deleteBranch: true },
      },
    );
    await select(repoBranchMenu(T.wtOther, dirty.deps), S.worktree.remove);
    expect(dirty.session.worktreeRemoveCheck).toHaveBeenCalledWith(`${PATH}-hotfix`);
    expect(dirty.prompt).toHaveBeenCalledWith({
      title: S.worktree.removeTitle(`${PATH}-hotfix`),
      message: `${S.worktree.removeDirty} ${S.worktree.removeNoUpstream}`,
      fields: [
        {
          key: 'deleteBranch',
          label: S.worktree.deleteBranchToo('hotfix/payment-timeout'),
          type: 'checkbox',
        },
      ],
      confirmLabel: S.dialog.delete,
    });
    expect(dirty.session.worktreeRemove).toHaveBeenCalledWith(`${PATH}-hotfix`, true, true);

    const unpushed = setup({}, { check: removeCheck({ unpushed: 2 }), prompt: {} });
    await select(repoBranchMenu(T.wtOther, unpushed.deps), S.worktree.remove);
    expect(unpushed.prompt.mock.calls[0]?.[0]).toMatchObject({
      message: S.worktree.removeUnpushed(2),
      fields: [],
    });
    expect(unpushed.session.worktreeRemove).toHaveBeenCalledWith(`${PATH}-hotfix`, false, false);

    const clean = setup({}, { check: removeCheck({ unpushed: 0 }), prompt: null });
    await select(repoBranchMenu(T.wtOther, clean.deps), S.worktree.remove);
    expect(clean.prompt.mock.calls[0]?.[0]).toMatchObject({ message: S.worktree.removeClean });
    expect(clean.session.worktreeRemove).not.toHaveBeenCalled();

    // 검사가 메인이라고 하면 묻지도 지우지도 않는다
    const main = setup({}, { check: removeCheck({ isMain: true, unpushed: 0 }) });
    await select(repoBranchMenu(T.wtOther, main.deps), S.worktree.remove);
    expect(main.prompt).not.toHaveBeenCalled();
    expect(main.session.worktreeRemove).not.toHaveBeenCalled();
  });

  it('백업: 새 branch 로 복원(이름 입력, 기본 <branch>-backup), 되돌리기(현재 branch 면 hard reset 경고), 삭제(확인 없음)', async () => {
    const asBranch = setup({}, { prompt: { name: 'staging-restored' } });
    await select(repoBranchMenu(T.backupStaging, asBranch.deps), S.safety.restoreAsBranch);
    expect(asBranch.prompt).toHaveBeenCalledWith({
      title: S.safety.restoreTitle,
      fields: [
        branchNameField({
          key: 'name',
          label: S.safety.restoreName,
          initial: 'staging-backup',
          required: true,
        }),
      ],
      confirmLabel: S.dialog.create,
    });
    expect(asBranch.session.backupRestore).toHaveBeenCalledWith(
      T.backupStaging.backup.name,
      'staging-restored',
    );

    // 체크아웃된 branch 를 되돌리면 reset --hard 다 — 그 경고를 쓴다
    const current = setup({ headBranch: 'main' });
    await select(repoBranchMenu(T.backupMain, current.deps), S.safety.restoreBranch('main'));
    expect(current.confirm).toHaveBeenCalledWith({
      title: S.safety.restoreBranch('main'),
      message: S.dialog.resetHardMessage,
      confirmLabel: S.dialog.apply,
      danger: true,
    });
    expect(current.session.backupRestore).toHaveBeenCalledWith(T.backupMain.backup.name, null);
    // 다른 branch 는 포인터만 옮긴다는 문구
    const other = setup({ headBranch: 'main' }, { confirm: false });
    await select(repoBranchMenu(T.backupStaging, other.deps), S.safety.restoreBranch('staging'));
    expect(other.confirm.mock.calls[0]?.[0]).toMatchObject({
      message: S.dialog.restoreOtherBranchMessage,
      danger: true,
    });
    expect(other.session.backupRestore).not.toHaveBeenCalled();

    const del = setup();
    await select(repoBranchMenu(T.backupStaging, del.deps), S.safety.deleteBackup);
    expect(del.session.backupDelete).toHaveBeenCalledWith(T.backupStaging.backup.name);
    expect(del.confirm).not.toHaveBeenCalled();
  });

  it('Worktrees 그룹 메뉴의 "워크트리 만들기…": 새 branch 이름 → 경로(제안값) → 만들기 (옛 머리 단추의 흐름)', async () => {
    const { deps, session, prompt } = setup();
    prompt
      .mockResolvedValueOnce({ name: 'spike' })
      .mockResolvedValueOnce({ path: '/mock/wt/spike' });
    await select(repoBranchMenu(T.wtGroup, deps), S.worktree.create);
    expect(prompt.mock.calls[0]?.[0]).toMatchObject({ title: S.worktree.createTitle });
    expect(session.suggestWorktreePath).toHaveBeenCalledWith('spike');
    expect(prompt.mock.calls[1]?.[0]).toMatchObject({
      title: S.worktree.pathTitle,
      fields: [{ key: 'path', initial: '/mock/wt/spike' }],
    });
    expect(session.worktreeAdd).toHaveBeenCalledWith('/mock/wt/spike', {
      kind: 'newBranch',
      name: 'spike',
      start: null,
    });
  });
});

describe('Tags 묶음의 tag 관리 열기·원격 tag 확인 (TG-09 ③, TG-10 ①)', () => {
  it('행 끝 단추와 묶음 메뉴가 같은 일(문서 열기, 모든 원격 확인)을 한다. 확인은 원격이 없거나 확인 중이면 끄고, 실행 중(busy)과는 무관하다', async () => {
    const { deps, session, openTagsDoc } = setup({ busy: true });
    const buttons = repoBranchRowActions(REPO_GROUP_IDS.tags, deps);
    expect(buttons.map((b) => [b.key, b.icon, b.label, b.disabled ?? false])).toEqual([
      ['openTagsDoc', 'tagsDoc', S.tag.doc.open, false],
      ['checkRemoteTags', 'rescan', S.tag.check.action, false],
    ]);
    for (const b of buttons) {
      b.onSelect();
    }
    const items = repoBranchMenu({ kind: 'tagGroup' }, deps);
    expect(shape(items)).toEqual([
      S.tag.doc.open,
      S.tag.pushAllTo('origin'),
      '---',
      S.tag.check.action,
    ]);
    await select(items, S.tag.doc.open);
    await select(items, S.tag.check.action);
    expect(openTagsDoc).toHaveBeenCalledTimes(2);
    expect(session.checkRemoteTags).toHaveBeenCalledTimes(2);
    expect(session.checkRemoteTags).toHaveBeenCalledWith();
    for (const state of [{ remotes: [] }, { tagChecking: true }]) {
      const off = repoBranchRowActions(REPO_GROUP_IDS.tags, setup(state).deps);
      expect(off.map((b) => b.disabled ?? false)).toEqual([false, true]);
      expect(offLabels(repoBranchMenu({ kind: 'tagGroup' }, setup(state).deps))).toEqual(
        state.remotes ? [S.tag.pushAll, S.tag.check.action] : [S.tag.check.action],
      );
    }
  });

  it('모든 tag push…(TG-13): 원격 하나면 평면, 둘 이상이면 원격 하위 메뉴. 누르면 그 원격으로 문서를 연다', async () => {
    const one = setup();
    await select(repoBranchMenu({ kind: 'tagGroup' }, one.deps), S.tag.pushAllTo('origin'));
    expect(one.openTagsDoc).toHaveBeenCalledWith({ kind: 'pushAll', remote: 'origin' });
    const two = setup({ remotes: ['origin', 'upstream'] });
    const items = repoBranchMenu({ kind: 'tagGroup' }, two.deps);
    expect(shape(items)[1]).toBe(`${S.tag.pushAll}▸ {origin, upstream}`);
    await select(items, 'upstream');
    expect(two.openTagsDoc).toHaveBeenCalledWith({ kind: 'pushAll', remote: 'upstream' });
  });

  it('원격에만 있는 tag 보기 (N): 확인한 원격에 원격에만 있는 tag 가 있을 때만, 그 원격의 필터로 연다', async () => {
    const report = (remote: string, names: string[]) => ({
      remote,
      checkedAt: 1,
      stale: false,
      lastError: null,
      counts: { localOnly: 0, remoteOnly: names.length, same: 0, diverged: 0, unknown: 0 },
      entries: names.map((name) => ({
        name,
        state: { kind: 'remoteOnly' as const },
        localObject: null,
        localCommit: null,
        remoteObject: null,
        remoteCommit: null,
      })),
      pushUrlDiffers: false,
    });
    expect(shape(repoBranchMenu({ kind: 'tagGroup' }, setup().deps))).not.toContain(
      S.tag.showRemoteOnly(1),
    );
    const { deps, openTagsDoc } = setup({
      remotes: ['origin', 'upstream'],
      tagReports: { origin: report('origin', []), upstream: report('upstream', ['v9', 'v8']) },
    });
    await select(repoBranchMenu({ kind: 'tagGroup' }, deps), S.tag.showRemoteOnly(2));
    expect(openTagsDoc).toHaveBeenCalledWith({ kind: 'remoteOnly', remote: 'upstream' });
  });
});

describe('Worktrees 그룹 행의 머리 단추 (옛 섹션 머리: ⌫ 정리·+ 만들기)', () => {
  it('폴더가 사라진 워크트리가 있을 때만 정리 단추(툴팁은 그 수)를 만들기 앞에 둔다. 다른 노드에는 없다', () => {
    const none = repoBranchRowActions(REPO_GROUP_IDS.worktrees, setup({ prunable: 0 }).deps);
    expect(none.map((a) => [a.key, a.icon, a.label, a.disabled])).toEqual([
      ['create', 'add', S.worktree.create, false],
    ]);
    const some = repoBranchRowActions(REPO_GROUP_IDS.worktrees, setup({ prunable: 2 }).deps);
    expect(some.map((a) => [a.key, a.icon, a.label, a.title])).toEqual([
      ['prune', 'prune', S.worktree.prune, S.safety.prunable(2)],
      ['create', 'add', S.worktree.create, undefined],
    ]);
    for (const id of [REPO_GROUP_IDS.local, 'ref:refs/heads/main', 'head']) {
      expect(repoBranchRowActions(id, setup({ prunable: 2 }).deps), id).toEqual([]);
    }
  });

  it('실행 중이면 둘 다 꺼진다 (진행 중 작업과는 무관). 정리 단추는 정리를 부른다', () => {
    const busy = repoBranchRowActions(
      REPO_GROUP_IDS.worktrees,
      setup({ prunable: 1, busy: true }).deps,
    );
    expect(busy.map((a) => a.disabled)).toEqual([true, true]);
    const inOp = repoBranchRowActions(
      REPO_GROUP_IDS.worktrees,
      setup({ prunable: 1, inOp: true }).deps,
    );
    expect(inOp.map((a) => a.disabled)).toEqual([false, false]);
    const { deps, session } = setup({ prunable: 1 });
    repoBranchRowActions(REPO_GROUP_IDS.worktrees, deps)[0]?.onSelect();
    expect(session.worktreePrune).toHaveBeenCalledTimes(1);
  });
});

describe('더블클릭·Enter (`openRepoBranch`): branch 는 그래프 거르기, 태그·워크트리는 지금까지대로', () => {
  /** 장면의 ref 라벨: master 와 그 업스트림, development 와 그 업스트림 */
  const LABELS: RefLabel[] = [
    local('master', { isCurrent: true }),
    local('development'),
    remoteLabel('origin', 'master'),
    remoteLabel('origin', 'development'),
    tagLabel('v2.4.0'),
  ];

  it('로컬·원격 branch 는 checkout 하지 않고 그래프를 [그 branch, master, origin/master] 로 거른다 (다른 질의 값은 그대로)', () => {
    const { deps, session } = setup();
    openRepoBranch(T.development, deps, LABELS);
    expect(session.setGraphQuery).toHaveBeenLastCalledWith({
      ...GRAPH_QUERY,
      revs: { kind: 'branches', names: ['development', 'master', 'origin/master'] },
    });
    openRepoBranch(T.originMain, deps, LABELS);
    expect(session.setGraphQuery).toHaveBeenLastCalledWith({
      ...GRAPH_QUERY,
      revs: { kind: 'branches', names: ['origin/main', 'master', 'origin/master'] },
    });
    // 현재 branch 도, 실행 중이어도 거른다 (읽기다)
    const busy = setup({ busy: true, inOp: true });
    openRepoBranch(T.main, busy.deps, LABELS);
    expect(busy.session.setGraphQuery).toHaveBeenLastCalledWith({
      ...GRAPH_QUERY,
      revs: { kind: 'branches', names: ['main', 'master', 'origin/master'] },
    });
    expect(session.checkout).not.toHaveBeenCalled();
    expect(busy.session.checkout).not.toHaveBeenCalled();
  });

  it('기본 branch 자신은 [master, origin/master] 이고, 범위가 이미 같으면 다시 읽지 않는다', () => {
    const master = { kind: 'local', label: LABELS[0] as RefLabel } satisfies RepoBranchTarget;
    const { deps, session } = setup();
    openRepoBranch(master, deps, LABELS);
    expect(session.setGraphQuery).toHaveBeenLastCalledWith({
      ...GRAPH_QUERY,
      revs: { kind: 'branches', names: ['master', 'origin/master'] },
    });
    const same = setup({
      graphQuery: {
        ...GRAPH_QUERY,
        revs: { kind: 'branches', names: ['master', 'origin/master'] },
      },
    });
    openRepoBranch(master, same.deps, LABELS);
    expect(same.session.setGraphQuery).not.toHaveBeenCalled();
  });

  it('태그는 그 커밋으로 분리 checkout, 워크트리는 탭으로 연다 (지금까지대로)', () => {
    const { deps, session, openRepositoryAt } = setup();
    openRepoBranch(T.tag, deps, LABELS);
    expect(session.checkout).toHaveBeenLastCalledWith({ kind: 'commit', oid: OID });
    openRepoBranch(T.wtOther, deps, LABELS);
    expect(openRepositoryAt).toHaveBeenCalledWith(`${PATH}-hotfix`);
  });

  it('이 탭의 워크트리·백업·HEAD 행·원격 그룹은 아무것도 하지 않고, 실행 중·진행 중 작업이면 태그 checkout 도 하지 않는다', () => {
    const { deps, session, openRepositoryAt } = setup();
    openRepoBranch(T.wtMain, deps, LABELS);
    openRepoBranch(T.backupMain, deps, LABELS);
    openRepoBranch({ kind: 'head', oid: OID }, deps, LABELS);
    openRepoBranch(T.origin, deps, LABELS);
    expect(session.checkout).not.toHaveBeenCalled();
    expect(session.setGraphQuery).not.toHaveBeenCalled();
    expect(openRepositoryAt).not.toHaveBeenCalled();
    for (const state of [{ busy: true }, { inOp: true }]) {
      const blocked = setup(state);
      openRepoBranch(T.tag, blocked.deps, LABELS);
      expect(blocked.session.checkout).not.toHaveBeenCalled();
      // 워크트리 열기는 쓰기가 아니라 막지 않는다 (옛 사이드바와 같다)
      openRepoBranch(T.wtOther, blocked.deps, LABELS);
      expect(blocked.openRepositoryAt).toHaveBeenCalledTimes(1);
    }
  });
});

describe('repoFocusRevs (저장소 탭 더블클릭 범위)', () => {
  const up = (name: string, upstream: string | null) => local(name, { upstream });
  it('master 가 있으면 master 와 그 업스트림', () => {
    const labels = [up('master', 'refs/remotes/origin/master'), remoteLabel('origin', 'master')];
    expect(repoFocusRevs('feature/x', labels)).toEqual({
      kind: 'branches',
      names: ['feature/x', 'master', 'origin/master'],
    });
  });

  it('master 가 없으면 main, 업스트림이 없으면 origin/<기본> 이 있을 때 그것', () => {
    const labels = [up('main', null), remoteLabel('origin', 'main')];
    expect(repoFocusRevs('feature/x', labels)).toEqual({
      kind: 'branches',
      names: ['feature/x', 'main', 'origin/main'],
    });
  });

  it('업스트림이 다른 원격이면 그 원격 branch 를 쓴다', () => {
    const labels = [
      up('master', 'upstream/master'),
      remoteLabel('upstream', 'master'),
      remoteLabel('origin', 'master'),
    ];
    expect(repoFocusRevs('x', labels)).toEqual({
      kind: 'branches',
      names: ['x', 'master', 'upstream/master'],
    });
  });

  it('둘 다 없으면 그 branch 하나(solo), 원격 짝이 없으면 로컬만', () => {
    expect(repoFocusRevs('x', [up('develop', null)])).toEqual({ kind: 'solo', name: 'x' });
    expect(repoFocusRevs('x', [up('master', null)])).toEqual({
      kind: 'branches',
      names: ['x', 'master'],
    });
    // 기본 branch 자신에 원격 짝이 없으면 클릭과 같은 범위다
    expect(repoFocusRevs('master', [up('master', null)])).toEqual({
      kind: 'solo',
      name: 'master',
    });
  });

  it('원격 행: 원격 기본 branch 자신을 누르면 [origin/master, master]', () => {
    const labels = [up('master', 'origin/master'), remoteLabel('origin', 'master')];
    expect(repoFocusRevs('origin/master', labels)).toEqual({
      kind: 'branches',
      names: ['origin/master', 'master'],
    });
  });
});
