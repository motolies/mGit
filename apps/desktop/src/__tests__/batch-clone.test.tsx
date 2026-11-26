// 여러 저장소 한꺼번에 clone: URL 여러 줄 해석(주석·중복·이름 지정·오류), 흐름(입력 → 상위 폴더 → 대상 체크 목록 →
// 실행 → 결과 알림), 앱 스토어(끝나면 폴더 탭 열기·다시 스캔·작업 기록), 작업 기록의 "실패한 저장소만 다시 실행".

import {
  type BatchResult,
  type CloneBatchRequest,
  createMockClient,
  createNullClient,
  type FolderSettings,
  type IpcClient,
  type SessionEvent,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useDialogs } from '../components/use-dialogs';
import { batchNotice } from '../features/folder/batch-report';
import { TaskHistoryPanel } from '../features/folder/TaskHistoryPanel';
import {
  type BatchCloneDeps,
  type BatchClonePreset,
  batchCloneFlow,
  cloneListError,
  cloneRetryPreset,
  formatCloneList,
  parseCloneList,
} from '../features/home/batch-clone';
import { getFolderStore, type TaskEntry, useAppStore } from '../store';
import { createAppStore } from '../store/app-store';
import { createFolderStore } from '../store/folder-store';
import { clearSessionRegistry, registerFolder } from '../store/session-registry';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

beforeAll(installDialogStub);
afterAll(removeDialogStub);
afterEach(() => {
  cleanup();
  clearSessionRegistry();
});

const m = S.clone.many;

describe('URL 여러 줄 해석', () => {
  it('빈 줄·주석을 건너뛰고 이름을 URL 에서 짓거나 줄의 둘째 값으로 받으며, 같은 URL 은 한 번만 넣는다', () => {
    const list = parseCloneList(
      [
        '',
        '# 팀 저장소',
        'https://github.com/team/app.git',
        '  git@github.com:team/api.git   api-server  # 서버',
        'https://github.com/team/app.git/',
        'https://github.com/team/docs',
        'C:\\work\\local-repo',
      ].join('\n'),
    );
    expect(list.targets).toEqual([
      { url: 'https://github.com/team/app.git', name: 'app', line: 3 },
      { url: 'git@github.com:team/api.git', name: 'api-server', line: 4 },
      { url: 'https://github.com/team/docs', name: 'docs', line: 6 },
      { url: 'C:\\work\\local-repo', name: 'local-repo', line: 7 },
    ]);
    expect(list.duplicates).toBe(1);
    expect(list.errors).toEqual([]);
    expect(list.nameClashes).toEqual([]);
  });

  it('- 로 시작하는 URL·쓸 수 없는 이름·셋 이상의 값은 그 줄 번호와 함께 오류다. 같은 폴더 이름은 대소문자 없이 겹친다', () => {
    expect(parseCloneList('-x\nhttps://h/a.git ..\nhttps://h/b.git b extra').errors).toEqual([
      { line: 1, error: 'badUrl' },
      { line: 2, error: 'badName' },
      { line: 3, error: 'tooManyParts' },
    ]);
    expect(parseCloneList('https://h/x.git a/b').errors).toEqual([{ line: 1, error: 'badName' }]);
    expect(parseCloneList('https://a/App.git\nhttps://b/app.git').nameClashes).toEqual([
      'App',
      'app',
    ]);
    expect(cloneListError('')).toBeNull();
    expect(cloneListError('# 주석만')).toBe(m.noTargets);
    expect(cloneListError('https://h/a.git\n-x')).toBe(m.errors.badUrl(2));
    expect(cloneListError('https://a/app.git\nhttps://b/app.git')).toBe(m.nameClash('app'));
    expect(cloneListError('https://a/app.git\nhttps://b/app.git other')).toBeNull();
  });

  it('다시 입력할 수 있는 줄로 되돌린다 (URL 에서 나오는 이름이면 URL 만)', () => {
    const targets = [
      { url: 'https://h/team/app.git', name: 'app' },
      { url: 'git@h:team/api.git', name: 'api-server' },
    ];
    const text = formatCloneList(targets);
    expect(text).toBe('https://h/team/app.git\ngit@h:team/api.git api-server');
    expect(parseCloneList(text).targets.map(({ url, name }) => ({ url, name }))).toEqual(targets);
  });
});

/** 흐름을 띄우는 시험용 화면 (대화상자 요소를 그린다) */
function Harness({
  deps,
  preset,
  done,
}: {
  deps: BatchCloneDeps;
  preset?: BatchClonePreset;
  done: (r: BatchResult | null) => void;
}) {
  const dialogs = useDialogs();
  // biome-ignore lint/correctness/useExhaustiveDependencies: 처음 그릴 때 한 번만 흐름을 연다
  useEffect(() => {
    void batchCloneFlow(dialogs, deps, preset).then(done);
  }, []);
  return dialogs.element;
}

/** 결과 하나 */
const RESULT: BatchResult = {
  label: '일괄 복제 (2개)',
  results: [
    { path: '/w/app', name: 'app', ok: true, skipped: null, message: '' },
    { path: '/w/api-server', name: 'api-server', ok: false, skipped: null, message: 'fatal: x' },
  ],
  succeeded: 1,
  skipped: 0,
  failed: 1,
};

const dialog = () => document.querySelector<HTMLDialogElement>('dialog[open]') as HTMLDialogElement;
const submit = async () => {
  act(() => fireEvent.submit(dialog().querySelector('form') as HTMLFormElement));
  await tick();
};

/** 흐름을 띄운다 */
async function startFlow(over: Partial<BatchCloneDeps> = {}, preset?: BatchClonePreset) {
  const deps: BatchCloneDeps = {
    pickDirectory: vi.fn(async () => '/w'),
    cloneRepositories: vi.fn(async (_r: CloneBatchRequest) => RESULT),
    notice: vi.fn(),
    ...over,
  };
  const done = vi.fn();
  render(<Harness deps={deps} preset={preset} done={done} />);
  await tick();
  return { deps, done };
}

describe('여러 저장소 clone 흐름', () => {
  it('URL 을 받아 상위 폴더를 고르고 대상 체크 목록에서 고른 것만 동시 2개로 clone 한 뒤 결과를 알린다', async () => {
    const { deps, done } = await startFlow();
    expect(dialog().querySelector('h2')?.textContent).toBe(m.title);
    const urls = within(dialog()).getByRole('textbox', { name: m.urls });
    act(() =>
      fireEvent.change(urls, {
        target: {
          value:
            'https://h/team/app.git\n# 주석\nhttps://h/team/app.git/\ngit@h:team/api.git api-server\nhttps://h/team/web.git',
        },
      }),
    );
    expect(dialog().textContent).toContain(m.count(3, 1));
    act(() => fireEvent.click(within(dialog()).getByRole('checkbox', { name: S.clone.blobless })));
    await submit();
    expect(deps.pickDirectory).toHaveBeenCalledWith(m.pickParent);
    // 대상 체크 목록: 상위 폴더와 `폴더 이름 ← URL`, 처음엔 모두 체크
    expect(dialog().querySelector('h2')?.textContent).toBe(m.confirmTitle(3));
    expect(dialog().textContent).toContain('/w');
    const boxes = within(dialog()).getAllByRole<HTMLInputElement>('checkbox');
    expect(boxes.map((b) => [b.closest('label')?.textContent, b.checked])).toEqual([
      [m.target('app', 'https://h/team/app.git'), true],
      [m.target('api-server', 'git@h:team/api.git'), true],
      [m.target('web', 'https://h/team/web.git'), true],
    ]);
    act(() => fireEvent.click(boxes[2] as HTMLElement));
    await submit();
    expect(deps.cloneRepositories).toHaveBeenCalledWith({
      parent: '/w',
      targets: [
        { url: 'https://h/team/app.git', name: 'app' },
        { url: 'git@h:team/api.git', name: 'api-server' },
      ],
      recurseSubmodules: false,
      depth: null,
      blobless: true,
      singleBranch: false,
      concurrency: 2,
    });
    expect(deps.notice).toHaveBeenCalledWith(batchNotice(RESULT));
    expect(done).toHaveBeenCalledWith(RESULT);
  });

  it('해석하지 못한 줄·겹치는 폴더 이름은 확인 단추를 끄고 사유를 보인다', async () => {
    const { deps } = await startFlow();
    const urls = within(dialog()).getByRole('textbox', { name: m.urls });
    const next = within(dialog()).getByRole<HTMLButtonElement>('button', { name: m.next });
    act(() => fireEvent.change(urls, { target: { value: 'https://h/a.git\n--upload-pack=x' } }));
    expect(next.disabled).toBe(true);
    expect(dialog().textContent).toContain(m.errors.badUrl(2));
    act(() =>
      fireEvent.change(urls, { target: { value: 'https://a/app.git\nhttps://b/app.git' } }),
    );
    expect(next.disabled).toBe(true);
    expect(dialog().textContent).toContain(m.nameClash('app'));
    await submit();
    expect(deps.pickDirectory).not.toHaveBeenCalled();
  });

  it('폴더 탭에서 열면 상위 폴더 선택 창을 그 폴더에서 열고, 다시 실행이면 같은 상위 폴더·옵션으로 고르지 않는다', async () => {
    const first = await startFlow({ defaultParent: '/folder' });
    act(() =>
      fireEvent.change(within(dialog()).getByRole('textbox', { name: m.urls }), {
        target: { value: 'https://h/a.git' },
      }),
    );
    await submit();
    expect(first.deps.pickDirectory).toHaveBeenCalledWith(m.pickParent, '/folder');
    cleanup();

    const { deps } = await startFlow(
      {},
      {
        text: 'https://h/b.git',
        parent: '/p',
        options: { recurseSubmodules: true, depth: 1, blobless: false, singleBranch: false },
      },
    );
    expect(within(dialog()).getByRole<HTMLTextAreaElement>('textbox', { name: m.urls }).value).toBe(
      'https://h/b.git',
    );
    expect(
      within(dialog()).getByRole<HTMLInputElement>('checkbox', { name: S.clone.recurse }).checked,
    ).toBe(true);
    await submit();
    expect(deps.pickDirectory).not.toHaveBeenCalled();
    await submit();
    expect(deps.cloneRepositories).toHaveBeenCalledWith(
      expect.objectContaining({ parent: '/p', depth: 1, recurseSubmodules: true }),
    );
  });
});

describe('앱 스토어의 여러 저장소 clone', () => {
  const FOLDER = '/mock/acme-platform';

  it('진행을 clone 작업으로 보이고, 끝나면 상위 폴더를 폴더 탭으로 열어 작업 기록에 요청과 함께 남긴다. 이미 열린 폴더면 다시 스캔한다', async () => {
    const events: SessionEvent[] = [
      { type: 'operationStarted', session: 0, opId: 7, kind: 'clone', label: '일괄 복제 (1개)' },
      {
        type: 'operationProgress',
        session: 0,
        opId: 7,
        phase: 'app',
        percent: 100,
        message: '',
      },
    ];
    const mock = createMockClient({ rows: 20, scene: 'folder', progressIntervalMs: 0 });
    const result: BatchResult = {
      label: '일괄 복제 (1개)',
      results: [{ path: `${FOLDER}/app`, name: 'app', ok: true, skipped: null, message: '' }],
      succeeded: 1,
      skipped: 0,
      failed: 0,
    };
    let seenOp: unknown = null;
    const client: IpcClient = {
      ...mock,
      cloneMany: vi.fn(async (_request, onEvent) => {
        for (const e of events) onEvent(e);
        seenOp = app.getState().cloneOp;
        return result;
      }),
    };
    const rescan = vi.spyOn(client, 'folderRescan');
    const app = createAppStore({ client, pickDirectory: async () => null });
    const request: CloneBatchRequest = {
      parent: FOLDER,
      targets: [{ url: 'https://h/app.git', name: 'app' }],
      recurseSubmodules: false,
      depth: null,
      blobless: false,
      singleBranch: false,
      concurrency: 2,
    };
    expect(await app.getState().cloneRepositories(request)).toEqual(result);
    expect(seenOp).toMatchObject({ id: 7, kind: 'clone', phase: 'app', percent: 100 });
    expect(app.getState().cloneOp).toBeNull();
    const id = app.getState().activeSessionId;
    expect(app.getState().sessions[id as number]).toMatchObject({ kind: 'folder' });
    const history = getFolderStore(id as number)?.getState().taskHistory ?? [];
    expect(history[0]).toMatchObject({ kind: 'batch', label: result.label, clone: request });
    expect(rescan).not.toHaveBeenCalled();
    // 두 번째는 이미 열린 폴더라 그 탭을 다시 스캔한다
    await app.getState().cloneRepositories(request);
    expect(rescan).toHaveBeenCalled();
    expect(getFolderStore(id as number)?.getState().taskHistory).toHaveLength(2);
  });
});

describe('작업 기록의 다시 실행', () => {
  const ID = 95;
  const SETTINGS: FolderSettings = {
    exclude: [],
    pullMode: 'ffOnly',
    concurrency: 4,
    autoRefreshSecs: 0,
    worktreeRoot: null,
  };
  const request: CloneBatchRequest = {
    parent: '/w',
    targets: [
      { url: 'https://h/team/app.git', name: 'app' },
      { url: 'https://h/team/api.git', name: 'api-server' },
      { url: 'https://h/team/web.git', name: 'web' },
    ],
    recurseSubmodules: false,
    depth: 1,
    blobless: false,
    singleBranch: true,
    concurrency: 2,
  };
  const entry: TaskEntry = {
    id: 1,
    kind: 'batch',
    label: '일괄 복제 (3개)',
    startedAt: 0,
    finishedAt: 0,
    result: {
      label: '일괄 복제 (3개)',
      results: [
        { path: '/w/app', name: 'app', ok: true, skipped: null, message: '' },
        { path: '/w/api-server', name: 'api-server', ok: false, skipped: null, message: 'x' },
        {
          path: '/w/web',
          name: 'web',
          ok: true,
          skipped: '취소됨',
          message: '',
          cancelled: true,
        },
      ],
      succeeded: 1,
      skipped: 0,
      failed: 1,
      cancelled: 1,
    },
    error: null,
    clone: request,
  };

  it('실패·취소된 대상과 같은 상위 폴더·옵션을 채운다. 다시 할 것이 없거나 clone 줄이 아니면 없다', () => {
    expect(cloneRetryPreset(entry)).toEqual({
      text: 'https://h/team/api.git api-server\nhttps://h/team/web.git',
      parent: '/w',
      options: { recurseSubmodules: false, depth: 1, blobless: false, singleBranch: true },
    });
    const allOk = {
      ...entry,
      result: { ...(entry.result as BatchResult), results: [entry.result?.results[0]] },
    } as TaskEntry;
    expect(cloneRetryPreset(allOk)).toBeNull();
    expect(cloneRetryPreset({ ...entry, clone: undefined })).toBeNull();
  });

  it('작업 기록 줄의 단추가 clone 창을 실패한 대상으로 다시 열고, 같은 상위 폴더로 실행한다', async () => {
    const client: IpcClient = { ...createNullClient(), folderSettings: async () => SETTINGS };
    const store = createFolderStore({ session: ID, path: '/w', repos: [] }, client);
    registerFolder(ID, store);
    const cloneRepositories = vi.fn(async (_r: CloneBatchRequest) => null);
    const pickDirectory = vi.fn(async () => null);
    const original = useAppStore.getState();
    act(() => {
      useAppStore.setState({
        client,
        sessions: { [ID]: { id: ID, kind: 'folder', path: '/w', name: 'w', parent: null } },
        sessionOrder: [ID],
        activeSessionId: ID,
        cloneRepositories,
        pickDirectory,
      });
    });
    await tick();
    act(() => store.setState({ taskHistory: [entry] }));
    render(<TaskHistoryPanel />);
    act(() =>
      fireEvent.click(screen.getByRole('button', { name: S.folder.history.retryFailed(2) })),
    );
    await tick();
    expect(within(dialog()).getByRole<HTMLTextAreaElement>('textbox', { name: m.urls }).value).toBe(
      'https://h/team/api.git api-server\nhttps://h/team/web.git',
    );
    await submit();
    await submit();
    expect(pickDirectory).not.toHaveBeenCalled();
    expect(cloneRepositories).toHaveBeenCalledWith(
      expect.objectContaining({ parent: '/w', depth: 1, singleBranch: true }),
    );
    act(() =>
      useAppStore.setState({
        cloneRepositories: original.cloneRepositories,
        pickDirectory: original.pickDirectory,
        client: original.client,
        sessions: {},
        sessionOrder: [],
        activeSessionId: null,
      }),
    );
  });
});
