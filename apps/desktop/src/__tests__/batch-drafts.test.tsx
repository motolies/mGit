// 일괄 작업 전 편집기 초안 확인: 작업 트리 파일을 바꾸는 일괄 작업(pull·checkout·branch 업데이트·스태시 저장·꺼내기)은 대상
// 저장소 안에 저장하지 않았거나 저장 중인 초안이 있으면 실행하지 않는다. 체크 목록이 있으면 그 저장소를 꺼진 칸으로 보이고,
// 입력 창이면 글에 미리 알리며, 확인 뒤(확인 없는 작업은 누른 순간) 다시 검사해 막는다 — 일괄 병합·리베이스와 같은 규칙.

import { EditorState } from '@codemirror/state';
import {
  type BatchOp,
  type BatchResult,
  createNullClient,
  type FolderSettings,
  type IpcClient,
  type RepoSummary,
  type StashBatch,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rewritesWorkTree } from '../features/folder/batch-drafts';
import { FolderBatchBar } from '../features/folder/FolderBatchBar';
import { TaskHistoryPanel } from '../features/folder/TaskHistoryPanel';
import { type TaskEntry, useAppStore } from '../store';
import { type EditorFile, fileEditors } from '../store/file-editor-store';
import { createFolderStore } from '../store/folder-store';
import { clearSessionRegistry, registerFolder } from '../store/session-registry';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

beforeAll(installDialogStub);
afterAll(removeDialogStub);
afterEach(() => {
  cleanup();
  clearSessionRegistry();
  vi.restoreAllMocks();
});

const ID = 93;
const ROOT = '/f';
const pathOf = (name: string) => `${ROOT}/${name}`;
const NAMES = ['api', 'auth', 'web'];
const t = S.folder.batch;

const SETTINGS: FolderSettings = {
  exclude: [],
  pullMode: 'ffOnly',
  concurrency: 4,
  autoRefreshSecs: 0,
  worktreeRoot: null,
};

/**
 * 폴더 탭에서 연 그 저장소 파일의 초안 (`saving` 이면 저장 중인 문서 — 고친 내용은 없다). 일괄 작업 뒤 파일 다시 읽기가
 * 이 문서를 건드리지 않게 구조 변경 잠금 상태로 둔다 (초안 검사는 잠금을 보지 않는다)
 */
function draftIn(repo: string, saving = false): EditorFile {
  return {
    dirty: !saving,
    ...(saving ? { inflight: Promise.resolve(true) } : {}),
    mutationLocked: true,
    imageEpoch: 0,
    bom: false,
    lineEnding: 'lf',
    state: EditorState.create({ doc: 'draft' }),
    sources: new Map([
      [String(ID), { client: createNullClient(), session: ID, path: `${repo}/a.ts` }],
    ]),
  } as unknown as EditorFile;
}

/** 편집기에 열린 문서를 정한다 (초안 검사가 읽는 목록) */
function openDocs(docs: EditorFile[]) {
  vi.spyOn(fileEditors, 'documents').mockReturnValue(docs);
}

/** 빈 결과 */
const EMPTY: BatchResult = { label: 'x', results: [], succeeded: 0, skipped: 0, failed: 0 };

/** 작업 기록 한 줄: 그 저장소들이 실패한 일괄 작업 (다시 실행 단추가 붙는다) */
function failedEntry(op: BatchOp, names: string[]): TaskEntry {
  return {
    id: 1,
    kind: 'batch',
    label: '작업',
    startedAt: 0,
    finishedAt: 0,
    result: {
      label: 'x',
      results: names.map((name) => ({
        path: pathOf(name),
        name,
        ok: false,
        skipped: null,
        message: 'fatal: x',
      })),
      succeeded: 0,
      skipped: 0,
      failed: names.length,
    },
    error: null,
    request: { op, repos: [] },
  };
}

/** 폴더 탭을 등록하고 일괄 줄과 작업 기록 탭을 그린다 */
async function mount(batches: StashBatch[] = [], entries: TaskEntry[] = []) {
  const folderBatch = vi.fn<IpcClient['folderBatch']>(async () => EMPTY);
  const client: IpcClient = {
    ...createNullClient(),
    folderSettings: async () => SETTINGS,
    folderBatch,
    folderStashBatches: async () => batches,
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
  render(
    <>
      <FolderBatchBar />
      <TaskHistoryPanel />
    </>,
  );
  return { store, folderBatch };
}

const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]') as HTMLDialogElement;

/** 열린 대화상자를 제출한다 */
async function submit(open: HTMLElement) {
  act(() => fireEvent.submit(open.querySelector('form') as HTMLFormElement));
  await tick();
}

/** 일괄 줄의 단추를 누른다 */
async function press(name: string) {
  act(() => fireEvent.click(screen.getByRole('button', { name })));
  await tick();
}

/** 지금까지의 알림: [종류, 제목, 본문] */
const toasts = () => useAppStore.getState().toasts.map((x) => [x.kind, x.title, x.message]);

/** 초안 때문에 막았다는 알림 (그 저장소 이름들) */
const blocked = (names: string) => ['error', t.draftsBlockedTitle, t.draftsBlocked(names)];

/** 저장소 요약 (지금 branch 만 쓴다) */
function summary(name: string, branch: string): RepoSummary {
  return {
    path: pathOf(name),
    name,
    kind: 'standalone',
    color: 0,
    branch,
    detached: false,
    changed: 0,
    conflicted: 0,
  };
}

describe('작업 트리를 바꾸는 작업인지', () => {
  it('pull·checkout·병합·리베이스·스태시는 늘, branch 업데이트는 checkout 된 branch 일 때만, branch 만들기는 시작점에서 checkout 할 때만', () => {
    const always: BatchOp[] = [
      { kind: 'pull' },
      { kind: 'checkout', name: 'x' },
      { kind: 'checkoutRemote', remote: 'origin', branch: 'x' },
      { kind: 'merge', reference: 'refs/heads/x', mode: 'default', targets: [] },
      { kind: 'rebase', reference: 'refs/heads/x', targets: [] },
      { kind: 'stashPush', batch: 'b', message: null, includeUntracked: false },
      { kind: 'stashPop', batch: 'b' },
    ];
    expect(always.map((op) => rewritesWorkTree(op, 'main'))).toEqual(always.map(() => true));
    const never: BatchOp[] = [
      { kind: 'fetch', prune: true },
      { kind: 'push', newUpstream: null },
      { kind: 'worktree', branch: 'x', destRoot: '/w', createBranch: true },
      { kind: 'renameBranch', from: 'a', to: 'b' },
      { kind: 'deleteBranch', name: 'x' },
      { kind: 'createBranch', name: 'x', checkout: true },
      { kind: 'createBranch', name: 'x', checkout: false, startPoint: 'refs/heads/dev' },
    ];
    expect(never.map((op) => rewritesWorkTree(op, 'main'))).toEqual(never.map(() => false));
    expect(
      rewritesWorkTree({
        kind: 'createBranch',
        name: 'x',
        checkout: true,
        startPoint: 'refs/heads/dev',
      }),
    ).toBe(true);
    const update: BatchOp = { kind: 'updateBranch', name: 'dev' };
    expect([
      rewritesWorkTree(update, 'dev'),
      rewritesWorkTree(update, 'main'),
      rewritesWorkTree(update, null),
      rewritesWorkTree(update, undefined),
    ]).toEqual([true, false, false, true]);
  });
});

describe('확인 없이 도는 작업', () => {
  it('Pull 은 대상에 초안이 있으면 실행하지 않고 그 저장소를 알린다. Fetch 는 파일을 바꾸지 않아 그대로 돈다', async () => {
    openDocs([draftIn('api')]);
    const { folderBatch } = await mount();
    await press(t.pull);
    expect(folderBatch).not.toHaveBeenCalled();
    expect(toasts()).toEqual([blocked('api')]);
    await press(t.fetch);
    expect(folderBatch).toHaveBeenCalledWith(ID, { kind: 'fetch', prune: true }, []);
  });

  it('저장 중인 문서도 막고, 초안이 대상 밖의 저장소에만 있으면 그대로 돈다', async () => {
    openDocs([draftIn('api', true)]);
    const { store, folderBatch } = await mount();
    await press(t.pull);
    expect(folderBatch).not.toHaveBeenCalled();
    expect(toasts()).toEqual([blocked('api')]);
    act(() => store.getState().setSelected([pathOf('auth')]));
    await press(t.pull);
    expect(folderBatch).toHaveBeenCalledWith(ID, { kind: 'pull' }, [pathOf('auth')]);
  });

  it('branch 업데이트(다시 실행)는 그 branch 가 checkout 된 저장소의 초안만 본다', async () => {
    openDocs([draftIn('api')]);
    const update: BatchOp = { kind: 'updateBranch', name: 'dev' };
    const { store, folderBatch } = await mount([], [failedEntry(update, ['api'])]);
    const retry = () =>
      act(() =>
        fireEvent.click(screen.getByRole('button', { name: S.folder.history.retryFailed(1) })),
      );
    // api 는 main 에 있다: dev 는 branch 만 옮기므로 그대로 돈다
    act(() => store.setState({ summaries: [summary('api', 'main')] }));
    retry();
    await tick();
    expect(folderBatch).toHaveBeenCalledWith(ID, update, [pathOf('api')]);
    // api 가 dev 에 있으면 작업 트리를 갱신하므로 막는다
    folderBatch.mockClear();
    act(() => store.setState({ summaries: [summary('api', 'dev')] }));
    retry();
    await tick();
    expect(folderBatch).not.toHaveBeenCalled();
    expect(toasts().at(-1)).toEqual(blocked('api'));
  });
});

describe('확인 창을 거치는 작업', () => {
  it('스태시 저장은 확인 창에 초안 저장소를 미리 알리고, 확인할 때도 남아 있으면 실행하지 않는다', async () => {
    openDocs([draftIn('api')]);
    const { folderBatch } = await mount();
    await press(t.stashSave);
    let open = dialog();
    expect(open.textContent).toContain(t.draftsNote('api'));
    await submit(open);
    expect(folderBatch).not.toHaveBeenCalled();
    expect(toasts()).toEqual([blocked('api')]);
    // 그사이 저장이 끝났으면 실행한다 (확인 창에도 알리지 않는다)
    openDocs([]);
    await press(t.stashSave);
    open = dialog();
    expect(open.textContent).not.toContain(t.draftsNote('api'));
    await submit(open);
    expect(folderBatch).toHaveBeenCalledTimes(1);
    expect(folderBatch.mock.calls[0]?.[1]).toMatchObject({ kind: 'stashPush' });
  });

  it('확인 창을 띄운 뒤 생긴 초안도 확인할 때 막는다 (branch 전환 이름 입력)', async () => {
    openDocs([]);
    const { folderBatch } = await mount();
    await press(t.checkout);
    const open = dialog();
    expect(open.textContent).not.toContain(t.draftsNote('web'));
    act(() =>
      fireEvent.change(within(open).getByRole('textbox', { name: t.branchName }), {
        target: { value: 'dev' },
      }),
    );
    openDocs([draftIn('web')]);
    await submit(open);
    expect(folderBatch).not.toHaveBeenCalled();
    expect(toasts()).toEqual([blocked('web')]);
  });

  it('스태시 꺼내기 체크 목록은 초안이 있는 저장소를 사유와 함께 꺼진 칸으로 보이고 나머지에서만 꺼낸다', async () => {
    openDocs([draftIn('api')]);
    const batch: StashBatch = {
      id: 'b1',
      message: '정리',
      time: 100,
      repos: ['api', 'auth'].map((name, index) => ({
        path: pathOf(name),
        name,
        index,
        branch: null,
        time: 100,
      })),
    };
    const { folderBatch } = await mount([batch]);
    await press(t.stashPop);
    const open = dialog();
    expect(
      within(open)
        .getAllByRole<HTMLInputElement>('checkbox')
        .map((box) => [box.closest('label')?.textContent, box.checked, box.disabled]),
    ).toEqual([
      [`${t.stashPopRepo('api', 0, null)}${S.folder.integration.pendingEditor}`, false, true],
      [t.stashPopRepo('auth', 1, null), true, false],
    ]);
    await submit(open);
    expect(folderBatch).toHaveBeenCalledWith(ID, { kind: 'stashPop', batch: 'b1' }, [
      pathOf('auth'),
    ]);
  });

  it('branch 전환 체크 목록(다시 실행)도 초안 저장소를 끄고, 모두 꺼졌으면 확인할 수 없다', async () => {
    openDocs([draftIn('api')]);
    const checkout: BatchOp = { kind: 'checkout', name: 'dev' };
    const { folderBatch } = await mount([], [failedEntry(checkout, ['api', 'auth'])]);
    act(() =>
      fireEvent.click(screen.getByRole('button', { name: S.folder.history.retryFailed(2) })),
    );
    await tick();
    let open = dialog();
    expect(
      within(open)
        .getAllByRole<HTMLInputElement>('checkbox')
        .map((box) => [box.closest('label')?.textContent, box.checked, box.disabled]),
    ).toEqual([
      [`api${S.folder.integration.pendingEditor}`, false, true],
      ['auth', true, false],
    ]);
    await submit(open);
    expect(folderBatch).toHaveBeenCalledWith(ID, checkout, [pathOf('auth')]);

    // 대상 모두에 초안이 있으면 확인 단추가 꺼지고 사유가 보인다
    openDocs([draftIn('api'), draftIn('auth')]);
    act(() =>
      fireEvent.click(screen.getByRole('button', { name: S.folder.history.retryFailed(2) })),
    );
    await tick();
    open = dialog();
    expect(open.textContent).toContain(S.folder.integration.noneEligible);
    expect(
      within(open).getByRole<HTMLButtonElement>('button', { name: S.menu.checkout }).disabled,
    ).toBe(true);
  });
});
