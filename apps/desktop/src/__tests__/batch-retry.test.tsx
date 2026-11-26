// 실패한 저장소만 다시 실행 (P1 D): 작업 기록 줄의 단추가 실패·취소된 저장소로 좁혀, 확인 없던 작업은 바로 다시 실행하고
// 확인 창이 있던 작업은 같은 확인 흐름을 이전 값으로 다시 연다.

import {
  type BatchOp,
  type BatchResult,
  createNullClient,
  type FolderBranches,
  type FolderSettings,
  type IpcClient,
  type RepoSummary,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { retryModeOf, retryPlan, retryTargets } from '../features/folder/batch-retry';
import { TaskHistoryPanel } from '../features/folder/TaskHistoryPanel';
import { type TaskEntry, useAppStore } from '../store';
import { createFolderStore } from '../store/folder-store';
import { clearSessionRegistry, registerFolder } from '../store/session-registry';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

beforeAll(installDialogStub);
afterAll(removeDialogStub);
afterEach(() => {
  cleanup();
  clearSessionRegistry();
});

const ID = 88;
const ROOT = '/f';
const pathOf = (name: string) => `${ROOT}/${name}`;
const NAMES = ['api', 'auth', 'web'];

/** 요약 한 줄 */
function summary(name: string, extra: Partial<RepoSummary> = {}): RepoSummary {
  return {
    path: pathOf(name),
    name,
    kind: 'standalone',
    color: 0,
    branch: 'main',
    detached: false,
    changed: 0,
    conflicted: 0,
    ahead: 1,
    behind: 0,
    op: null,
    lastFetch: null,
    error: null,
    ...extra,
  };
}

/** api·auth 는 보낼 commit 이 있고, web 은 업스트림 없이 origin 이 아닌 원격이 둘이다 */
const SUMMARIES = [
  summary('api'),
  summary('auth'),
  summary('web', { ahead: null, behind: null, remotes: ['team', 'fork'] }),
];

const SETTINGS: FolderSettings = {
  exclude: [],
  pullMode: 'ffOnly',
  concurrency: 4,
  autoRefreshSecs: 0,
  worktreeRoot: null,
};

/** 결과 한 줄: 성공 / 실패 / 취소됨 */
function row(name: string, state: 'ok' | 'failed' | 'cancelled'): BatchResult['results'][number] {
  return {
    path: pathOf(name),
    name,
    ok: state !== 'failed',
    skipped: state === 'cancelled' ? '취소됨' : null,
    message: state === 'failed' ? 'fatal: x' : '',
    ...(state === 'cancelled' ? { cancelled: true } : {}),
  };
}

/** 결과 (수는 줄에서 센다) */
function result(rows: BatchResult['results']): BatchResult {
  const cancelled = rows.filter((r) => r.cancelled).length;
  return {
    label: '일괄 작업',
    results: rows,
    succeeded: rows.filter((r) => r.ok && !r.skipped).length,
    skipped: rows.filter((r) => r.skipped && !r.cancelled).length,
    failed: rows.filter((r) => !r.ok).length,
    cancelled,
  };
}

/** 작업 기록 한 줄 (일괄 작업, 실행 인자 포함) */
function entry(id: number, op: BatchOp, rows: BatchResult['results']): TaskEntry {
  return {
    id,
    kind: 'batch',
    label: `작업 ${id}`,
    startedAt: 0,
    finishedAt: 0,
    result: result(rows),
    error: null,
    request: { op, repos: [] },
  };
}

/** 폴더 탭을 등록하고 작업 기록 탭을 그린다 (`overrides` 로 클라이언트 응답을 바꾼다) */
async function mount(entries: TaskEntry[], overrides: Partial<IpcClient> = {}) {
  const folderBatch = vi.fn<IpcClient['folderBatch']>(async () => result([]));
  const client: IpcClient = {
    ...createNullClient(),
    folderSummaries: async () => SUMMARIES,
    folderSettings: async () => SETTINGS,
    folderBatch,
    ...overrides,
  };
  const store = createFolderStore(
    {
      session: ID,
      path: ROOT,
      repos: NAMES.map((name) => ({ path: pathOf(name), kind: 'standalone' as const })),
    },
    client,
  );
  registerFolder(ID, store);
  act(() => {
    useAppStore.setState({
      client,
      sessions: { [ID]: { id: ID, kind: 'folder', path: ROOT, name: 'f', parent: null } },
      sessionOrder: [ID],
      activeSessionId: ID,
      toasts: [],
    });
  });
  await tick();
  act(() => store.setState({ taskHistory: entries }));
  render(<TaskHistoryPanel />);
  return { store, folderBatch };
}

const t = S.folder.history;
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]') as HTMLDialogElement;

describe('다시 실행 규칙', () => {
  it('확인 없던 작업은 바로, 확인이 있던 작업은 확인을 다시 열고, 원격 branch 삭제는 다시 실행하지 않는다', () => {
    const modes = (
      [
        { kind: 'fetch', prune: true },
        { kind: 'pull' },
        { kind: 'updateBranch', name: 'main' },
        { kind: 'push' },
        { kind: 'createBranch', name: 'x', checkout: true },
        { kind: 'checkout', name: 'x' },
        { kind: 'checkoutRemote', remote: 'origin', branch: 'x' },
        { kind: 'worktree', branch: 'x', destRoot: '/w', createBranch: true },
        { kind: 'renameBranch', from: 'a', to: 'b' },
        { kind: 'deleteBranch', name: 'x' },
        { kind: 'merge', reference: 'refs/heads/x', mode: 'default', targets: [] },
        { kind: 'rebase', reference: 'refs/heads/x', targets: [] },
        { kind: 'deleteRemoteBranch', targets: [], deleteLocal: false },
        { kind: 'deleteLocalBranches', targets: [] },
        { kind: 'stashPush', batch: 'b1', message: null, includeUntracked: false },
        { kind: 'stashPop', batch: 'b1' },
      ] as BatchOp[]
    ).map((op) => [op.kind, retryModeOf(op)]);
    expect(Object.fromEntries(modes)).toEqual({
      fetch: 'direct',
      pull: 'direct',
      updateBranch: 'direct',
      push: 'confirm',
      createBranch: 'confirm',
      checkout: 'confirm',
      checkoutRemote: 'confirm',
      worktree: 'confirm',
      renameBranch: 'confirm',
      deleteBranch: 'confirm',
      merge: 'confirm',
      rebase: 'confirm',
      deleteRemoteBranch: null,
      deleteLocalBranches: null,
      stashPush: 'confirm',
      stashPop: 'confirm',
    });
  });

  it('대상은 실패하거나 취소된 저장소이고, 없거나 실행 인자가 없거나 commit 줄이면 계획이 없다', () => {
    const rows = [row('api', 'ok'), row('auth', 'failed'), row('web', 'cancelled')];
    expect(retryTargets(result(rows))).toEqual([
      { path: pathOf('auth'), name: 'auth' },
      { path: pathOf('web'), name: 'web' },
    ]);
    const fetch = entry(1, { kind: 'fetch', prune: true }, rows);
    expect(retryPlan(fetch)?.mode).toBe('direct');
    expect(retryPlan(entry(2, { kind: 'pull' }, [row('api', 'ok')]))).toBeNull();
    expect(retryPlan({ ...fetch, request: undefined })).toBeNull();
    expect(retryPlan({ ...fetch, kind: 'commit' })).toBeNull();
    expect(
      retryPlan(entry(3, { kind: 'deleteRemoteBranch', targets: [], deleteLocal: false }, rows)),
    ).toBeNull();
  });
});

describe('작업 기록의 "실패한 저장소만 다시 실행"', () => {
  it('실패·취소된 줄에만 단추가 있고, fetch 는 그 저장소에서 바로 다시 실행한다. 도는 동안 꺼진다', async () => {
    const { store, folderBatch } = await mount([
      entry(2, { kind: 'fetch', prune: true }, [
        row('api', 'ok'),
        row('auth', 'failed'),
        row('web', 'cancelled'),
      ]),
      entry(1, { kind: 'pull' }, [row('api', 'ok')]),
    ]);
    const buttons = screen.getAllByRole<HTMLButtonElement>('button', { name: t.retryFailed(2) });
    expect(buttons).toHaveLength(1);
    const retry = buttons[0] as HTMLButtonElement;
    expect(retry.title).toBe(t.retryDirectTip);
    act(() => store.setState({ batchRunning: true }));
    expect(retry.disabled).toBe(true);
    act(() => store.setState({ batchRunning: false }));
    act(() => fireEvent.click(retry));
    await tick();
    expect(folderBatch).toHaveBeenCalledWith(ID, { kind: 'fetch', prune: true }, [
      pathOf('auth'),
      pathOf('web'),
    ]);
    // 다시 실행한 결과도 기록에 쌓인다
    expect(store.getState().taskHistory).toHaveLength(3);
  });

  it('push 는 체크 목록을 실패 저장소로 좁혀 다시 열고, 골랐던 새 업스트림 원격을 처음 값으로 둔다', async () => {
    const op: BatchOp = {
      kind: 'push',
      newUpstream: { remotes: [{ path: pathOf('web'), remote: 'fork' }] },
    };
    const { folderBatch } = await mount([
      entry(1, op, [row('api', 'failed'), row('auth', 'ok'), row('web', 'cancelled')]),
    ]);
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: t.retryFailed(2) });
    expect(retry.title).toBe(t.retryConfirmTip);
    act(() => fireEvent.click(retry));
    await tick();
    const open = dialog();
    expect(open.querySelector('h2')?.textContent).toBe(S.folder.batch.pushTitle);
    // auth(성공)는 목록에 없다
    expect(
      within(open)
        .getAllByRole<HTMLInputElement>('checkbox')
        .map((box) => [box.closest('label')?.textContent, box.checked]),
    ).toEqual([
      [S.folder.batch.pushCommits('api', 1), true],
      [S.folder.batch.pushChoose('web', 'main'), true],
    ]);
    expect(
      within(open).getByRole<HTMLSelectElement>('combobox', {
        name: S.folder.batch.pushRemote('web'),
      }).value,
    ).toBe('fork');
    expect(folderBatch).not.toHaveBeenCalled();
    act(() => fireEvent.submit(open.querySelector('form') as HTMLFormElement));
    await tick();
    expect(folderBatch).toHaveBeenCalledWith(
      ID,
      { kind: 'push', newUpstream: { remotes: [{ path: pathOf('web'), remote: 'fork' }] } },
      [pathOf('api'), pathOf('web')],
    );
  });

  it('branch 만들기는 이전 이름·checkout 을 채운 입력창을 실패 저장소로 다시 연다. 취소하면 실행하지 않는다', async () => {
    const { folderBatch } = await mount([
      entry(1, { kind: 'createBranch', name: 'feat-x', checkout: false }, [
        row('api', 'failed'),
        row('auth', 'ok'),
      ]),
    ]);
    act(() => fireEvent.click(screen.getByRole('button', { name: t.retryFailed(1) })));
    await tick();
    let open = dialog();
    expect(open.querySelector('h2')?.textContent).toBe(S.folder.batch.branchTitle);
    expect(open.textContent).toContain(S.folder.batch.targets(S.folder.repos(1), 'api'));
    expect(
      within(open).getByRole<HTMLInputElement>('textbox', { name: S.folder.batch.branchName })
        .value,
    ).toBe('feat-x');
    expect(
      within(open).getByRole<HTMLInputElement>('checkbox', { name: S.folder.batch.branchCheckout })
        .checked,
    ).toBe(false);
    act(() => fireEvent.click(within(open).getByRole('button', { name: S.confirm.cancel })));
    await tick();
    expect(folderBatch).not.toHaveBeenCalled();

    act(() => fireEvent.click(screen.getByRole('button', { name: t.retryFailed(1) })));
    await tick();
    open = dialog();
    act(() => fireEvent.submit(open.querySelector('form') as HTMLFormElement));
    await tick();
    expect(folderBatch).toHaveBeenCalledWith(
      ID,
      { kind: 'createBranch', name: 'feat-x', checkout: false },
      [pathOf('api')],
    );
  });

  it('checkout 은 branch 전환 체크 목록으로 다시 열고, 지금 그 branch 인 저장소는 표시하고 체크를 뺀다', async () => {
    const { folderBatch } = await mount([
      entry(1, { kind: 'checkout', name: 'main' }, [row('api', 'failed'), row('web', 'failed')]),
    ]);
    act(() => fireEvent.click(screen.getByRole('button', { name: t.retryFailed(2) })));
    await tick();
    const open = dialog();
    // 요약에서 두 저장소 모두 지금 main 이다
    expect(
      within(open)
        .getAllByRole<HTMLInputElement>('checkbox')
        .map((box) => [box.closest('label')?.textContent, box.checked]),
    ).toEqual([
      [S.folder.timeline.checkoutCurrent('api'), false],
      [S.folder.timeline.checkoutCurrent('web'), false],
    ]);
    expect(folderBatch).not.toHaveBeenCalled();
  });
});

describe('다시 실행 뒤 로그 범위 (브랜치 칸에서 시작한 것과 같은 후처리)', () => {
  /** 로컬 branch 이름들만 있는 브랜치 목록 (다시 읽기가 읽는 값) */
  const branchesOf = (names: readonly string[]): FolderBranches =>
    ({
      repos: [],
      branches: names.map((name) => ({ name, remote: false, repos: [] })),
    }) as unknown as FolderBranches;

  /** 로그 범위를 그 branch 하나로 건다 */
  function scopeTo(store: Awaited<ReturnType<typeof mount>>['store'], name: string) {
    const timeline = store.getState().timeline;
    act(() =>
      store.setState({
        timeline: { ...timeline, query: { ...timeline.query, revs: { kind: 'solo', name } } },
      }),
    );
  }

  it('이름 바꾸기를 다시 실행해 옛 이름이 모두 사라지면 범위의 옛 이름을 새 이름으로 바꾼다', async () => {
    let names = ['development'];
    const querySet = vi.fn<IpcClient['folderTimelineQuerySet']>(async () => {});
    const { store, folderBatch } = await mount(
      [
        entry(1, { kind: 'renameBranch', from: 'development', to: 'dev-2' }, [
          row('api', 'failed'),
        ]),
      ],
      { folderBranches: async () => branchesOf(names), folderTimelineQuerySet: querySet },
    );
    folderBatch.mockImplementation(async () => {
      names = ['dev-2'];
      return result([row('api', 'ok')]);
    });
    scopeTo(store, 'development');
    act(() => fireEvent.click(screen.getByRole('button', { name: t.retryFailed(1) })));
    await tick();
    act(() => fireEvent.submit(dialog().querySelector('form') as HTMLFormElement));
    await waitFor(() =>
      expect(store.getState().timeline.query.revs).toEqual({ kind: 'solo', name: 'dev-2' }),
    );
    expect(folderBatch).toHaveBeenCalledWith(
      ID,
      { kind: 'renameBranch', from: 'development', to: 'dev-2' },
      [pathOf('api')],
    );
    expect(querySet).toHaveBeenLastCalledWith(
      ID,
      expect.objectContaining({ revs: { kind: 'solo', name: 'dev-2' } }),
    );
  });

  it('삭제를 다시 실행해 어느 저장소에도 남지 않으면 범위에서 빼고(HEAD 범위로), 남으면 그대로 둔다', async () => {
    let names = ['hotfix'];
    const { store, folderBatch } = await mount(
      [entry(1, { kind: 'deleteBranch', name: 'hotfix' }, [row('api', 'failed')])],
      {
        folderBranches: async () => branchesOf(names),
        folderTimelineQuerySet: async () => {},
      },
    );
    folderBatch.mockImplementation(async () => result([row('api', 'ok')]));
    scopeTo(store, 'hotfix');
    const retry = async () => {
      act(() => fireEvent.click(screen.getByRole('button', { name: t.retryFailed(1) })));
      await tick();
      act(() => fireEvent.submit(dialog().querySelector('form') as HTMLFormElement));
      await tick();
      await tick();
    };
    // 다른 저장소에 hotfix 가 남았으면 범위는 그대로다
    await retry();
    expect(store.getState().timeline.query.revs).toEqual({ kind: 'solo', name: 'hotfix' });
    // 다시 실행으로 마지막 저장소에서도 지우면 범위에서 빠진다
    folderBatch.mockImplementation(async () => {
      names = [];
      return result([row('api', 'ok')]);
    });
    act(() =>
      store.setState({
        taskHistory: [entry(2, { kind: 'deleteBranch', name: 'hotfix' }, [row('api', 'failed')])],
      }),
    );
    await retry();
    await waitFor(() => expect(store.getState().timeline.query.revs).toEqual({ kind: 'head' }));
  });
});
