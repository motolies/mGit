// 폴더 선택 창 제목과 워크트리 폴더 열기 단추 (#1·#12·#11): 앱 인스턴스는 흐름이 넘긴 제목을 그대로 창에 쓰고(예전에는
// 폴더 스캔 말고는 늘 "저장소 열기"), 저장소 열기·폴더 스캔도 제목 글자를 넘긴다. 폴더 일괄 워크트리는 기본 폴더 고르기
// 창에 그 용도를 적고, 다 만든 뒤 묻는 확인 단추는 "폴더 열기" 다.

import { type BatchResult, createNullClient, type FolderSettings, type IpcClient } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FolderBatchBar } from '../features/folder/FolderBatchBar';
import { cloneFlow, initFlow } from '../features/home/repo-flows';
import { useAppStore } from '../store';
import { createAppStore } from '../store/app-store';
import { createFolderStore } from '../store/folder-store';
import { clearSessionRegistry, registerFolder } from '../store/session-registry';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

const ipc = vi.hoisted(() => ({ pickDirectory: vi.fn(async (_title: string) => null) }));

vi.mock('@mgit/ipc', async (orig) => {
  const m = await orig<typeof import('@mgit/ipc')>();
  return { ...m, pickDirectory: ipc.pickDirectory, createTauriClient: () => m.createNullClient() };
});

beforeAll(installDialogStub);
afterAll(removeDialogStub);
afterEach(() => {
  cleanup();
  clearSessionRegistry();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('폴더 선택 창 제목', () => {
  it('실제 앱 인스턴스(목 아님)는 넘긴 제목을 그대로 창 제목으로 쓴다', async () => {
    vi.stubEnv('VITE_MGIT_MOCK', '0');
    vi.resetModules();
    const { useAppStore: real } = await import('../store/app-store-instance');
    for (const title of [S.clone.pickParent, S.init.pickParent, S.folder.batch.worktreeRoot]) {
      await real.getState().pickDirectory(title);
    }
    expect(ipc.pickDirectory.mock.calls.map(([title]) => title)).toEqual([
      S.clone.pickParent,
      S.init.pickParent,
      S.folder.batch.worktreeRoot,
    ]);
  });

  it('저장소 열기·폴더 스캔·clone·새 저장소는 용도의 제목을 넘긴다', async () => {
    const pickDirectory = vi.fn(async (_title: string) => null);
    const app = createAppStore({ client: createNullClient(), pickDirectory });
    await app.getState().openRepository();
    await app.getState().scanFolder();
    const d = { prompt: vi.fn(async () => ({ url: 'https://x/y.git' })) };
    await cloneFlow(d as never, { pickDirectory, cloneRepository: vi.fn(async () => true) });
    await initFlow(d as never, {
      pickDirectory,
      templates: [],
      initRepository: vi.fn(async () => true),
    });
    expect(pickDirectory.mock.calls.map(([title]) => title)).toEqual([
      S.toolbar.openRepo,
      S.home.scanTitle,
      S.clone.pickParent,
      S.init.pickParent,
    ]);
  });
});

describe('폴더 일괄 워크트리', () => {
  const ID = 95;
  const ROOT = '/f';
  const SETTINGS: FolderSettings = {
    exclude: [],
    pullMode: 'ffOnly',
    concurrency: 4,
    autoRefreshSecs: 0,
    worktreeRoot: null,
  };
  const DONE: BatchResult = {
    label: 'x',
    results: [{ path: `${ROOT}/api`, name: 'api', ok: true, skipped: null, message: '' }],
    succeeded: 1,
    skipped: 0,
    failed: 0,
  };

  it('기본 폴더가 없으면 용도를 적은 제목으로 폴더를 고르고, 다 만든 뒤 "폴더 열기" 로 그 폴더를 연다', async () => {
    const client: IpcClient = {
      ...createNullClient(),
      folderSettings: async () => SETTINGS,
      folderBatch: vi.fn(async () => DONE),
    };
    const store = createFolderStore(
      { session: ID, path: ROOT, repos: [{ path: `${ROOT}/api`, kind: 'standalone' }] },
      client,
    );
    registerFolder(ID, store);
    const pickDirectory = vi.fn(async (_title: string) => '/wt');
    const openFolderAt = vi.fn(async () => {});
    act(() => {
      useAppStore.setState({
        client,
        sessions: { [ID]: { id: ID, kind: 'folder', path: ROOT, name: 'f', parent: null } },
        sessionOrder: [ID],
        activeSessionId: ID,
        toasts: [],
        pickDirectory,
        openFolderAt,
      });
    });
    await tick();
    render(<FolderBatchBar />);
    act(() => fireEvent.click(screen.getByRole('button', { name: S.folder.batch.worktree })));
    await tick();
    expect(pickDirectory).toHaveBeenCalledWith(S.folder.batch.worktreeRoot);
    let open = document.querySelector('dialog[open]') as HTMLDialogElement;
    act(() =>
      fireEvent.change(within(open).getByRole('textbox', { name: S.folder.batch.worktreeBranch }), {
        target: { value: 'feat' },
      }),
    );
    act(() => fireEvent.submit(open.querySelector('form') as HTMLFormElement));
    await tick();
    open = document.querySelector('dialog[open]') as HTMLDialogElement;
    expect(open.querySelector('h2')?.textContent).toBe(S.folder.batch.openWorktrees);
    const run = within(open).getByRole('button', { name: S.folder.batch.openWorktreesRun });
    expect(within(open).queryByRole('button', { name: S.home.open })).toBeNull();
    act(() => fireEvent.click(run));
    await tick();
    expect(openFolderAt).toHaveBeenCalledWith('/wt');
  });
});
