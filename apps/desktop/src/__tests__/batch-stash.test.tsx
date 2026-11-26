// 폴더 일괄 스태시 (셋째 묶음 G): 저장 대화상자(메시지·미추적 파일 포함 처음엔 꺼짐, 새 묶음 id), 꺼내기(묶음 고르기 →
// 남은 저장소 체크 목록), 작업 기록의 "이 묶음 꺼내기", 실패한 저장소만 다시 실행, 변경으로 건너뜀 안내.

import {
  type BatchOp,
  type BatchResult,
  createNullClient,
  type FolderSettings,
  type IpcClient,
  type StashBatch,
} from '@mgit/ipc';
import { formatDateTime, S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { batchNotice, dirtySkippedCount } from '../features/folder/batch-report';
import { retryModeOf, retryPlan } from '../features/folder/batch-retry';
import {
  newStashBatchId,
  stashBatchName,
  stashBatchOfEntry,
  stashBatchOption,
} from '../features/folder/batch-stash';
import { FolderBatchBar } from '../features/folder/FolderBatchBar';
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

const ID = 91;
const ROOT = '/f';
const pathOf = (name: string) => `${ROOT}/${name}`;
const NAMES = ['api', 'auth', 'web'];
const t = S.folder.batch;

const SETTINGS: FolderSettings = {
  exclude: ['web'],
  pullMode: 'ffOnly',
  concurrency: 4,
  autoRefreshSecs: 0,
  worktreeRoot: null,
};

/** 묶음 하나 (저장소 이름들, stash 인덱스는 순서대로) */
function batch(id: string, message: string, time: number, names: string[]): StashBatch {
  return {
    id,
    message,
    time,
    repos: names.map((name, i) => ({
      path: pathOf(name),
      name,
      index: i,
      branch: i === 0 ? 'main' : null,
      time,
    })),
  };
}

/** 결과 한 줄: 성공 / 실패 / 건너뜀 */
function row(name: string, state: 'ok' | 'failed' | 'skipped'): BatchResult['results'][number] {
  return {
    path: pathOf(name),
    name,
    ok: state !== 'failed',
    skipped: state === 'skipped' ? '스태시할 변경이 없습니다' : null,
    message: state === 'failed' ? 'fatal: x' : '',
  };
}

/** 결과 (수는 줄에서 센다) */
function result(rows: BatchResult['results']): BatchResult {
  return {
    label: '스태시 일괄 저장',
    results: rows,
    succeeded: rows.filter((r) => r.ok && !r.skipped).length,
    skipped: rows.filter((r) => r.skipped).length,
    failed: rows.filter((r) => !r.ok).length,
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

/** 폴더 탭을 등록하고 일괄 줄과 작업 기록 탭을 그린다 */
async function mount(batches: StashBatch[], entries: TaskEntry[] = []) {
  const folderBatch = vi.fn<IpcClient['folderBatch']>(async () => result([]));
  const folderStashBatches = vi.fn<IpcClient['folderStashBatches']>(async () => batches);
  const client: IpcClient = {
    ...createNullClient(),
    folderSettings: async () => SETTINGS,
    folderBatch,
    folderStashBatches,
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
  return { store, folderBatch, folderStashBatches };
}

const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]') as HTMLDialogElement;

/** 열린 대화상자의 체크 칸: [글자, 체크됨, 꺼짐] */
function checkboxes(open: HTMLElement) {
  return within(open)
    .getAllByRole<HTMLInputElement>('checkbox')
    .map((box) => [box.closest('label')?.textContent, box.checked, box.disabled]);
}

/** 열린 대화상자를 제출한다 */
async function submit(open: HTMLElement) {
  act(() => fireEvent.submit(open.querySelector('form') as HTMLFormElement));
  await tick();
}

describe('묶음 id·이름', () => {
  it('묶음 id 는 시각(36진)과 난수 세 자리로, 코어가 받는 글자만 쓴다', () => {
    expect(newStashBatchId(0, () => 0)).toBe('0000');
    expect(newStashBatchId(36, () => 0.5)).toBe(`10${Math.floor(0.5 * 36 ** 3).toString(36)}`);
    expect(newStashBatchId()).toMatch(/^[0-9a-z]{4,40}$/);
  });

  it('메시지가 없으면 id 로 이름을 짓고, 고르기 칸에는 저장소 수와 시각을 붙인다', () => {
    expect(stashBatchName({ id: 'b1', message: '' })).toBe(t.stashBatchUnnamed('b1'));
    expect(stashBatchName({ id: 'b1', message: '정리' })).toBe('정리');
    const b = batch('b1', '정리', 1_700_000_000, ['api', 'auth']);
    expect(stashBatchOption(b)).toBe(t.stashBatchOption('정리', 2, formatDateTime(1_700_000_000)));
  });
});

describe('일괄 스태시 저장', () => {
  it('메시지와 미추적 파일 포함(처음엔 꺼짐)을 받아 새 묶음 id 로 전체 저장소에 저장한다', async () => {
    const { folderBatch } = await mount([]);
    act(() => fireEvent.click(screen.getByRole('button', { name: t.stashSave })));
    await tick();
    const open = dialog();
    expect(open.querySelector('h2')?.textContent).toBe(t.stashSaveTitle);
    // 체크 칸은 미추적 파일 포함 하나뿐이다 (글자 옆에 안내가 붙어 이름에 섞인다)
    const untracked = within(open).getByRole<HTMLInputElement>('checkbox');
    expect(untracked.closest('label')?.textContent).toBe(
      `${S.stash.includeUntracked}${t.stashUntrackedNote}`,
    );
    expect(untracked.checked).toBe(false);
    expect(open.textContent).toContain(t.stashUntrackedNote);
    act(() =>
      fireEvent.change(within(open).getByRole('textbox', { name: S.stash.message }), {
        target: { value: ' 정리 ' },
      }),
    );
    await submit(open);
    expect(folderBatch).toHaveBeenCalledTimes(1);
    const [, op, repos] = folderBatch.mock.calls[0] as [number, BatchOp, string[]];
    expect(op).toEqual({
      kind: 'stashPush',
      batch: expect.stringMatching(/^[0-9a-z]{4,40}$/),
      message: '정리',
      includeUntracked: false,
    });
    expect(repos).toEqual([]);
  });

  it('메시지를 비우면 null 로 넘기고, 취소하면 실행하지 않는다', async () => {
    const { folderBatch } = await mount([]);
    act(() => fireEvent.click(screen.getByRole('button', { name: t.stashSave })));
    await tick();
    act(() => fireEvent.click(within(dialog()).getByRole('button', { name: S.confirm.cancel })));
    await tick();
    expect(folderBatch).not.toHaveBeenCalled();
    act(() => fireEvent.click(screen.getByRole('button', { name: t.stashSave })));
    await tick();
    const open = dialog();
    act(() => fireEvent.click(within(open).getByRole('checkbox')));
    await submit(open);
    expect(folderBatch.mock.calls[0]?.[1]).toMatchObject({
      kind: 'stashPush',
      message: null,
      includeUntracked: true,
    });
  });
});

describe('일괄 스태시 꺼내기', () => {
  it('묶음이 여럿이면 최근 묶음을 처음 값으로 고르게 하고, 고른 묶음의 저장소 체크 목록을 거쳐 꺼낸다', async () => {
    const recent = batch('b2', '', 200, ['api']);
    const older = batch('b1', '정리', 100, ['api', 'auth', 'web']);
    const { folderBatch, folderStashBatches } = await mount([recent, older]);
    act(() => fireEvent.click(screen.getByRole('button', { name: t.stashPop })));
    await tick();
    expect(folderStashBatches).toHaveBeenCalledWith(ID, []);
    let open = dialog();
    expect(open.querySelector('h2')?.textContent).toBe(t.stashPickTitle);
    const select = within(open).getByRole<HTMLSelectElement>('combobox', { name: t.stashBatch });
    expect(select.value).toBe('b2');
    expect([...select.options].map((o) => o.textContent)).toEqual([
      stashBatchOption(recent),
      stashBatchOption(older),
    ]);
    act(() => fireEvent.change(select, { target: { value: 'b1' } }));
    await submit(open);

    open = dialog();
    expect(open.querySelector('h2')?.textContent).toBe(t.stashPopTitle('정리'));
    // web 은 폴더 설정에서 뺀 저장소라 꺼진 칸이다
    expect(checkboxes(open)).toEqual([
      [`${t.stashPopRepo('api', 0, 'main')}`, true, false],
      [`${t.stashPopRepo('auth', 1, null)}`, true, false],
      [`${t.stashPopRepo('web', 2, null)}${t.excluded}`, false, true],
    ]);
    act(() => fireEvent.click(within(open).getAllByRole('checkbox')[1] as HTMLElement));
    await submit(open);
    expect(folderBatch).toHaveBeenCalledWith(ID, { kind: 'stashPop', batch: 'b1' }, [
      pathOf('api'),
    ]);
  });

  it('묶음이 하나면 바로 체크 목록을 열고, 없으면 알리고 끝낸다', async () => {
    const { folderBatch } = await mount([batch('b1', '정리', 100, ['auth'])]);
    act(() => fireEvent.click(screen.getByRole('button', { name: t.stashPop })));
    await tick();
    const open = dialog();
    expect(open.querySelector('h2')?.textContent).toBe(t.stashPopTitle('정리'));
    await submit(open);
    expect(folderBatch).toHaveBeenCalledWith(ID, { kind: 'stashPop', batch: 'b1' }, [
      pathOf('auth'),
    ]);
    cleanup();
    clearSessionRegistry();

    const none = await mount([]);
    act(() => fireEvent.click(screen.getByRole('button', { name: t.stashPop })));
    await tick();
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(useAppStore.getState().toasts.map((x) => [x.kind, x.title])).toEqual([
      ['info', t.stashNone],
    ]);
    expect(none.folderBatch).not.toHaveBeenCalled();
  });
});

describe('작업 기록과 다시 실행', () => {
  const push: BatchOp = {
    kind: 'stashPush',
    batch: 'b1',
    message: '정리',
    includeUntracked: true,
  };

  it('저장에 성공한 저장소가 있는 스태시 저장 줄에만 "이 묶음 꺼내기" 가 있고, 누르면 그 묶음만 꺼낸다', async () => {
    expect(stashBatchOfEntry(entry(1, push, [row('api', 'skipped')]))).toBeNull();
    expect(stashBatchOfEntry(entry(1, { kind: 'pull' }, [row('api', 'ok')]))).toBeNull();
    const { folderBatch, folderStashBatches } = await mount(
      [batch('b9', '다른 묶음', 300, ['api']), batch('b1', '정리', 100, ['api', 'auth'])],
      [entry(1, push, [row('api', 'ok'), row('auth', 'ok')])],
    );
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: S.folder.history.popBatch,
    });
    expect(button.title).toBe(S.folder.history.popBatchTip);
    act(() => fireEvent.click(button));
    await tick();
    expect(folderStashBatches).toHaveBeenCalledWith(ID, []);
    // 다른 묶음이 있어도 고르기 없이 그 묶음의 체크 목록이 열린다
    const open = dialog();
    expect(open.querySelector('h2')?.textContent).toBe(t.stashPopTitle('정리'));
    await submit(open);
    expect(folderBatch).toHaveBeenCalledWith(ID, { kind: 'stashPop', batch: 'b1' }, [
      pathOf('api'),
      pathOf('auth'),
    ]);
  });

  it('남은 묶음이 없으면 알린다', async () => {
    const { folderBatch } = await mount([], [entry(1, push, [row('api', 'ok')])]);
    act(() => fireEvent.click(screen.getByRole('button', { name: S.folder.history.popBatch })));
    await tick();
    expect(useAppStore.getState().toasts.map((x) => [x.kind, x.title])).toEqual([
      ['info', t.stashBatchGone],
    ]);
    expect(folderBatch).not.toHaveBeenCalled();
  });

  it('저장·꺼내기 모두 확인 창을 다시 연다. 저장은 같은 묶음·메시지·미추적 파일 포함으로 실패 저장소에만', async () => {
    expect(retryModeOf(push)).toBe('confirm');
    expect(retryModeOf({ kind: 'stashPop', batch: 'b1' })).toBe('confirm');
    expect(retryPlan(entry(1, push, [row('api', 'ok'), row('auth', 'failed')]))?.targets).toEqual([
      { path: pathOf('auth'), name: 'auth' },
    ]);
    const { folderBatch } = await mount(
      [],
      [entry(1, push, [row('api', 'ok'), row('auth', 'failed')])],
    );
    act(() =>
      fireEvent.click(screen.getByRole('button', { name: S.folder.history.retryFailed(1) })),
    );
    await tick();
    const open = dialog();
    expect(open.querySelector('h2')?.textContent).toBe(t.stashSaveTitle);
    // 다시 실행의 대상은 사용자가 고른 것이 아니므로 `저장소 N개` 로 적는다 (#7)
    expect(open.textContent).toContain(t.targets(S.folder.repos(1), 'auth'));
    expect(
      within(open).getByRole<HTMLInputElement>('textbox', { name: S.stash.message }).value,
    ).toBe('정리');
    expect(within(open).getByRole<HTMLInputElement>('checkbox').checked).toBe(true);
    await submit(open);
    expect(folderBatch).toHaveBeenCalledWith(ID, push, [pathOf('auth')]);
  });

  it('꺼내기 다시 실행은 실패 저장소에서 그 묶음을 다시 찾아 체크 목록을 연다', async () => {
    const pop: BatchOp = { kind: 'stashPop', batch: 'b1' };
    const { folderBatch, folderStashBatches } = await mount(
      [batch('b1', '정리', 100, ['auth'])],
      [entry(1, pop, [row('api', 'ok'), row('auth', 'failed')])],
    );
    act(() =>
      fireEvent.click(screen.getByRole('button', { name: S.folder.history.retryFailed(1) })),
    );
    await tick();
    expect(folderStashBatches).toHaveBeenCalledWith(ID, [pathOf('auth')]);
    await submit(dialog());
    expect(folderBatch).toHaveBeenCalledWith(ID, pop, [pathOf('auth')]);
  });
});

describe('커밋하지 않은 변경으로 건너뜀 안내', () => {
  it('건너뛴 저장소가 있으면 알림 끝에 스태시 저장 안내를 붙이고, 없으면 붙이지 않는다', () => {
    const rows: BatchResult['results'] = [
      { ...row('api', 'ok') },
      {
        path: pathOf('auth'),
        name: 'auth',
        ok: true,
        skipped: '커밋하지 않은 변경이 있습니다',
        message: '',
        skippedDirty: true,
      },
    ];
    const r = result(rows);
    expect(dirtySkippedCount(r)).toBe(1);
    const lines = batchNotice(r).message.split('\n');
    expect(lines.at(-1)).toBe(t.dirtyHint(1));
    expect(batchNotice(result([row('api', 'skipped')])).message).not.toContain(t.dirtyHint(1));
  });
});
