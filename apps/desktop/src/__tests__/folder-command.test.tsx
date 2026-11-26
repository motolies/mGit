// 선택한 저장소들에 git 명령 실행 (MR-14): 개요 일괄 줄의 "명령 실행…" → 입력(최근 명령·셸 문법 거부·위험 경고) → 위험한
// 명령은 한 번 더 확인 → 실행 → 작업 기록 탭에서 저장소별 종료 코드·출력 보기·복사, 실패한 저장소만 다시 실행, 오래된 출력 정리.

import {
  type BatchOp,
  type BatchResult,
  createNullClient,
  type FolderSettings,
  type IpcClient,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchNotice } from '../features/folder/batch-report';
import { retryModeOf } from '../features/folder/batch-retry';
import { commandOutputsText } from '../features/folder/CommandOutput';
import { FolderBatchBar } from '../features/folder/FolderBatchBar';
import { readRecentCommands } from '../features/folder/recent-commands';
import { TaskHistoryPanel } from '../features/folder/TaskHistoryPanel';
import { type TaskEntry, useAppStore } from '../store';
import { DEFAULT_DOCK } from '../store/app-store';
import { COMMAND_OUTPUT_KEEP, createFolderStore, pruneCommandOutputs } from '../store/folder-store';
import { clearSessionRegistry, registerFolder } from '../store/session-registry';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

beforeAll(installDialogStub);
afterAll(removeDialogStub);
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  clearSessionRegistry();
});

const ID = 93;
const ROOT = '/f';
const pathOf = (name: string) => `${ROOT}/${name}`;
const NAMES = ['api', 'auth', 'web'];
const c = S.folder.command;

const SETTINGS: FolderSettings = {
  exclude: ['web'],
  pullMode: 'ffOnly',
  concurrency: 4,
  autoRefreshSecs: 0,
  worktreeRoot: null,
};

type Row = BatchResult['results'][number];

/** 명령을 실행한 저장소 한 줄 */
function ran(name: string, status: number, stdout: string, stderr = ''): Row {
  return {
    path: pathOf(name),
    name,
    ok: status === 0,
    skipped: null,
    message: status === 0 ? '' : stderr.trim(),
    command: {
      status,
      elapsedMs: 1500,
      stdout,
      stdoutTruncated: false,
      stderr,
      stderrTruncated: false,
    },
  };
}

/** 결과 (수는 줄에서 센다) */
function result(rows: Row[]): BatchResult {
  return {
    label: '명령 실행: git status -sb',
    results: rows,
    succeeded: rows.filter((r) => r.ok && !r.skipped).length,
    skipped: rows.filter((r) => r.skipped).length,
    failed: rows.filter((r) => !r.ok).length,
  };
}

/** 이번 실행의 결과: api 성공(출력), auth 실패(종료 코드 128), web 은 폴더 설정에서 빼 건너뜀 */
const RESULT = result([
  ran('api', 0, '## main\n M src/a.ts\n'),
  ran('auth', 128, '', 'fatal: Needed a single revision\n'),
  { path: pathOf('web'), name: 'web', ok: true, skipped: '제외됨 (폴더 설정)', message: '' },
]);

/** 폴더 탭을 등록하고 일괄 줄과 작업 기록 탭을 그린다 */
async function mount(entries: TaskEntry[] = []) {
  const folderBatch = vi.fn<IpcClient['folderBatch']>(async () => RESULT);
  const client: IpcClient = {
    ...createNullClient(),
    folderSettings: async () => SETTINGS,
    folderBatch,
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
      dock: { ...DEFAULT_DOCK, gitTab: 'log' },
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
/** 명령 입력 칸 (제안 목록이 붙으면 역할이 combobox 라 이름표로 찾는다) */
const commandBox = () => within(dialog()).getByLabelText<HTMLInputElement>(c.label);
/** 입력 창의 실행 단추 */
const runButton = () => within(dialog()).getByRole<HTMLButtonElement>('button', { name: c.run });

/** "명령 실행…" 을 눌러 입력 창을 연다 */
async function openCommand() {
  act(() => fireEvent.click(screen.getByRole('button', { name: c.button })));
  await tick();
}

/** 명령을 입력한다 */
function type(value: string) {
  act(() => fireEvent.change(commandBox(), { target: { value } }));
}

/** 열린 대화상자를 제출한다 */
async function submit() {
  act(() => fireEvent.submit(dialog().querySelector('form') as HTMLFormElement));
  await tick();
}

describe('명령 입력과 실행', () => {
  it('입력한 git 명령을 고른 저장소(없으면 전부)에서 실행하고, 작업 기록 탭을 열어 저장소별 종료 코드·출력을 펼쳐 보인다', async () => {
    const { folderBatch } = await mount();
    await openCommand();
    expect(dialog().querySelector('h2')?.textContent).toBe(c.title);
    expect(dialog().textContent).toContain(c.note);
    expect(commandBox().value).toBe('');
    expect(commandBox().placeholder).toBe(c.placeholder);
    // 비었으면 실행 단추가 꺼진다 (필수 칸)
    expect(runButton().disabled).toBe(true);
    type('git status -sb');
    expect(runButton().disabled).toBe(false);
    await submit();
    expect(folderBatch).toHaveBeenCalledWith(
      ID,
      { kind: 'runCommand', args: ['status', '-sb'] },
      [],
    );
    // 이 폴더의 최근 명령으로 남는다
    expect(readRecentCommands(ROOT)).toEqual(['git status -sb']);
    // 작업 기록 탭이 열리고, 맨 위 줄이 펼쳐져 저장소별 결과가 보인다
    expect(useAppStore.getState().dock).toMatchObject({ tool: 'git', gitTab: 'history' });
    const items = screen.getAllByRole('listitem').filter((li) => li.closest('ul') !== null);
    const api = items.find((li) => li.textContent?.startsWith('api'));
    const auth = items.find((li) => li.textContent?.startsWith('auth'));
    expect(api?.textContent).toContain(`${c.exit(0)} · ${c.elapsed(1500)}`);
    expect(api?.getAttribute('data-state')).toBe('ok');
    expect(
      within(api as HTMLElement).getByRole('region', { name: c.stdout }).textContent,
    ).toContain(' M src/a.ts');
    expect(auth?.getAttribute('data-state')).toBe('failed');
    expect(
      within(auth as HTMLElement).getByRole('region', { name: c.stderr }).textContent,
    ).toContain('fatal: Needed a single revision');
    // 출력 숨기기 → 다시 보기
    const toggle = within(api as HTMLElement).getByRole('button', { name: c.hideOutput });
    act(() => fireEvent.click(toggle));
    expect(within(api as HTMLElement).queryByRole('region', { name: c.stdout })).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    // 결과 알림: 실패한 저장소의 사유
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain(
      'auth: fatal: Needed a single revision',
    );
  });

  it('다음에 열면 가장 최근 명령이 처음 값이고 최근 명령은 칸의 제안 목록이다', async () => {
    await mount();
    await openCommand();
    type('log --oneline -3');
    await submit();
    await openCommand();
    expect(commandBox().value).toBe('git log --oneline -3');
    // 제안 목록이 붙은 칸은 콤보 상자로 알린다
    expect(within(dialog()).getByRole('combobox', { name: c.label })).toBe(commandBox());
    const list = document.getElementById(commandBox().getAttribute('list') ?? '');
    expect([...(list?.querySelectorAll('option') ?? [])].map((o) => o.value)).toEqual([
      'git log --oneline -3',
    ]);
  });

  it('셸 문법·닫히지 않은 따옴표·git 만 입력은 실행 단추를 끄고 사유를 보인다', async () => {
    const { folderBatch } = await mount();
    await openCommand();
    for (const [input, reason] of [
      ['log | head', c.errors.shellSyntax],
      ['status && ls', c.errors.shellSyntax],
      ["log --grep='x", c.errors.unclosedQuote],
      ['git', c.errors.empty],
    ] as const) {
      type(input);
      expect(runButton().disabled, input).toBe(true);
      expect(dialog().textContent, input).toContain(reason);
    }
    await submit();
    expect(folderBatch).not.toHaveBeenCalled();
  });

  it('위험한 명령은 입력 창에서 경고하고 실행 전에 한 번 더 묻는다. 취소하면 실행하지 않는다', async () => {
    const { folderBatch } = await mount();
    await openCommand();
    type('push --force origin main');
    expect(dialog().textContent).toContain(c.dangerNotice(c.danger.forcePush));
    await submit();
    let open = dialog();
    expect(open.querySelector('h2')?.textContent).toBe(c.dangerTitle);
    expect(open.textContent).toContain('git push --force origin main');
    expect(open.textContent).toContain(c.danger.forcePush);
    act(() => fireEvent.click(within(open).getByRole('button', { name: S.confirm.cancel })));
    await tick();
    expect(folderBatch).not.toHaveBeenCalled();
    // 다시 열어 그래도 실행하면 돈다
    await openCommand();
    type('reset --hard');
    await submit();
    open = dialog();
    expect(open.textContent).toContain(c.danger.discardChanges);
    act(() => fireEvent.click(within(open).getByRole('button', { name: c.dangerRun })));
    await tick();
    expect(folderBatch).toHaveBeenCalledWith(
      ID,
      { kind: 'runCommand', args: ['reset', '--hard'] },
      [],
    );
  });

  it('자격 증명이 든 명령은 실행하되 최근 명령에 남기지 않는다', async () => {
    const { folderBatch } = await mount();
    await openCommand();
    type('remote add backup https://user:s3cret@example.com/r.git');
    await submit();
    expect(folderBatch).toHaveBeenCalledTimes(1);
    expect(readRecentCommands(ROOT)).toEqual([]);
    expect(localStorage.getItem(`mgit.folder.commands:${ROOT}`)).toBeNull();
  });
});

describe('작업 기록의 일괄 명령 줄', () => {
  /** 일괄 명령 작업 기록 한 줄 */
  function commandEntry(id: number, rows: Row[], args = ['status', '-sb']): TaskEntry {
    return {
      id,
      kind: 'batch',
      label: `명령 ${id}`,
      startedAt: 0,
      finishedAt: 0,
      result: result(rows),
      error: null,
      request: { op: { kind: 'runCommand', args }, repos: [] },
    };
  }

  it('모든 저장소 출력 복사는 저장소마다 머리를 붙여 한 글자로 복사한다', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await mount([commandEntry(1, RESULT.results)]);
    act(() => fireEvent.click(screen.getByRole('button', { name: c.copyAll })));
    expect(writeText).toHaveBeenCalledWith(commandOutputsText(RESULT.results));
    const text = writeText.mock.calls[0]?.[0] ?? '';
    expect(text).toContain(`== api · ${c.exit(0)} · ${c.elapsed(1500)} ==\n## main`);
    expect(text).toContain('== web · ');
    // 저장소 하나의 출력 복사
    const api = screen
      .getAllByRole('listitem')
      .find((li) => li.textContent?.startsWith('api')) as HTMLElement;
    act(() => fireEvent.click(within(api).getByRole('button', { name: c.copy })));
    expect(writeText).toHaveBeenLastCalledWith('## main\n M src/a.ts\n');
  });

  it('실패한 저장소만 다시 실행은 같은 명령을 채운 입력 창을 그 저장소로 좁혀 다시 연다', async () => {
    const { folderBatch } = await mount([
      commandEntry(1, RESULT.results, ['rev-parse', '--verify', 'feature']),
    ]);
    expect(retryModeOf({ kind: 'runCommand', args: ['status'] })).toBe('confirm');
    act(() =>
      fireEvent.click(screen.getByRole('button', { name: S.folder.history.retryFailed(1) })),
    );
    await tick();
    expect(commandBox().value).toBe('git rev-parse --verify feature');
    expect(dialog().textContent).toContain(S.folder.batch.targets(S.folder.repos(1), 'auth'));
    await submit();
    expect(folderBatch).toHaveBeenCalledWith(
      ID,
      { kind: 'runCommand', args: ['rev-parse', '--verify', 'feature'] },
      [pathOf('auth')],
    );
  });

  it('최근 몇 개를 넘는 일괄 명령 줄은 출력만 지우고 종료 코드는 남기며, 그 줄은 지웠다고 알린다', async () => {
    const entries = Array.from({ length: COMMAND_OUTPUT_KEEP + 1 }, (_, i) =>
      commandEntry(i + 1, [ran('api', 0, `out ${i}\n`)]),
    );
    const pruned = pruneCommandOutputs(entries);
    expect(pruned.slice(0, COMMAND_OUTPUT_KEEP)).toEqual(entries.slice(0, COMMAND_OUTPUT_KEEP));
    const last = pruned[COMMAND_OUTPUT_KEEP];
    expect(last?.outputsDropped).toBe(true);
    expect(last?.result?.results[0]?.command).toMatchObject({ status: 0, stdout: '', stderr: '' });
    // 명령 줄이 아닌 기록은 세지도 바꾸지도 않는다
    const plain: TaskEntry = { ...entries[0], id: 99, request: undefined } as TaskEntry;
    plain.result = result([
      { path: pathOf('api'), name: 'api', ok: true, skipped: null, message: '' },
    ]);
    expect(pruneCommandOutputs([plain, ...entries])[0]).toBe(plain);
    // 지운 줄은 (맨 위 명령 줄이라 펼친 채로) 안내만 보이고 복사 단추가 없다
    await mount([{ ...(last as TaskEntry) }]);
    const row = screen.getByRole('button', { name: new RegExp(`명령 ${last?.id}`) });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(c.outputsDropped)).toBeTruthy();
    expect(screen.queryByRole('button', { name: c.copyAll })).toBeNull();
  });

  it('결과 알림에는 실패한 저장소의 stderr 마지막 줄이 사유로 붙는다', () => {
    const notice = batchNotice(RESULT);
    expect(notice.kind).toBe('error');
    expect(notice.message).toContain('auth: fatal: Needed a single revision');
  });
});

describe('일괄 명령 인자 (작업 종류)', () => {
  it('runCommand 는 실행 인자 배열을 그대로 싣는다', () => {
    const op: BatchOp = { kind: 'runCommand', args: ['log', '--format=%h %s'] };
    expect(op.args).toEqual(['log', '--format=%h %s']);
  });
});
