import type { GraphViewProps } from '@mgit/graph-view';
import {
  type CommandLogRecord,
  createMockClient,
  GraphRangeCache,
  type SessionId,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { CommandLogView } from '../features/log/CommandLogPanel';
import { getFolderStore, getSessionStore, useAppStore } from '../store';
import { DEFAULT_DOCK } from '../store/app-store';
import { createFolderStore } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  registerFolder,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { createWorkspaceStore } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

// 로그·터미널·홈은 jsdom 에서 그리지 않는다 (뷰 자체는 각 패키지가 테스트한다)
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (_props: GraphViewProps) => <div data-testid="graph-view" />,
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

const FOLDER = '/mock/acme-platform';
const AUTH = `${FOLDER}/auth-service`;
const WEB = `${FOLDER}/web-console`;

/** 기록 하나 */
function record(id: number, extra: Partial<CommandLogRecord> = {}): CommandLogRecord {
  return {
    id,
    args: ['push'],
    cwd: WEB,
    startedAt: 1_763_500_000_000,
    elapsedMs: 912,
    status: 0,
    stderrTail: '',
    isWrite: true,
    cancelled: false,
    ...extra,
  };
}

const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/** 폴더 탭을 등록하고 앱 전체를 그린다 (Git 도구 창은 로그 탭) */
async function mountFolder() {
  const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
  const opened = await mock.openFolder(FOLDER, (e) =>
    getFolderStore(e.session)?.getState().applyEvent(e),
  );
  const id = opened.session;
  mounted.push(id);
  registerFolder(id, createFolderStore(opened, mock));
  registerWorkspace(id, createWorkspaceStore('folder'));
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'folder', path: FOLDER, name: 'acme-platform', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      client: mock,
      repoSessions: {},
      repoSessionOpening: {},
    }),
  );
  render(<App />);
  await tick();
  return { mock, id, folder: () => getFolderStore(id) };
}

/** Git 도구 창 (아래 슬롯) */
const dock = () => within(screen.getByRole('region', { name: S.dock.label }));
/** 콘솔 탭 단추 */
const consoleTab = () =>
  dock()
    .getAllByRole('tab')
    .find((t) => t.textContent?.startsWith(S.dock.tabs.console)) as HTMLElement;
/** 콘솔의 줄들 */
const consoleRows = () =>
  [
    ...(screen.getByRole('region', { name: S.log.title }).querySelectorAll<HTMLElement>('li') ??
      []),
  ] as HTMLElement[];

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
});

afterEach(() => {
  cleanup();
  removeDialogStub();
  act(() =>
    useAppStore.setState({
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      repoSessions: {},
      repoSessionOpening: {},
      client: originalClient,
      toasts: [],
    }),
  );
  for (const id of mounted) {
    disposeFolder(id);
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('콘솔 줄 뷰 (CommandLogView, 저장소 탭·폴더 탭 공용)', () => {
  it('폴더 탭의 줄은 저장소 칸(색·이름)이 더해지고, 실패 표시·stderr 펼치기·명령줄 복사가 저장소 탭과 같다', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const web = { path: WEB, name: 'web-console', color: 7 };
    render(
      <CommandLogView
        rows={[
          {
            record: record(2, { status: 1, stderrTail: ' ! [rejected] staging -> staging' }),
            repo: web,
          },
          { record: record(1, { args: ['fetch', '--all'], cwd: `${FOLDER}/web-wt` }), repo: web },
        ]}
        emptyText="x"
      />,
    );
    const [failed, fetched] = consoleRows();
    expect(failed?.dataset.failed).toBe('true');
    expect(fetched?.dataset.failed).toBe('false');
    expect(failed?.dataset.repo).toBe('true');
    const chip = within(failed as HTMLElement).getByRole('button', { name: 'web-console' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.title).toBe(S.log.narrowTip('web-console'));
    expect(
      (chip.querySelector('span[style]') as HTMLElement).style.getPropertyValue('--repo-color'),
    ).toBe('var(--repo-color-7, var(--graph-lane-7))');
    // 워크트리에서 돈 명령은 실제 작업 디렉터리를 툴팁에 더한다
    expect(
      within(fetched as HTMLElement).getByRole('button', { name: 'web-console' }).title,
    ).toContain(S.log.cwdTip(`${FOLDER}/web-wt`));
    expect(failed?.textContent).toContain(`${S.log.elapsed(912)} · ${S.log.exit(1)}`);

    // stderr 펼치기
    expect(failed?.querySelector('pre')).toBeNull();
    fireEvent.click(within(failed as HTMLElement).getByRole('button', { name: 'git push' }));
    expect(failed?.querySelector('pre')?.textContent).toBe(' ! [rejected] staging -> staging');
    // 복사
    await act(async () => {
      fireEvent.click(within(failed as HTMLElement).getByRole('button', { name: S.log.copy }));
    });
    expect(writeText).toHaveBeenCalledWith('git push');
    expect(within(failed as HTMLElement).getByRole('button', { name: S.log.copied })).toBeTruthy();
  });

  it('저장소 칸을 누르면 좁히기·되돌리기를 알리고, 좁혀 보는 중이면 위에 표시와 전체 보기가 붙는다', () => {
    const onNarrow = vi.fn();
    const web = { path: WEB, name: 'web-console', color: 7 };
    const { rerender } = render(
      <CommandLogView
        rows={[{ record: record(1), repo: web }]}
        emptyText="x"
        onNarrow={onNarrow}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'web-console' }));
    expect(onNarrow).toHaveBeenLastCalledWith(WEB);
    rerender(
      <CommandLogView
        rows={[{ record: record(1), repo: web }]}
        emptyText="x"
        narrowed={web}
        onNarrow={onNarrow}
      />,
    );
    expect(screen.getByText(S.log.narrowed('web-console'))).toBeTruthy();
    const chip = screen.getByRole('button', { name: 'web-console' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.title).toBe(S.log.widenTip('web-console'));
    fireEvent.click(chip);
    expect(onNarrow).toHaveBeenLastCalledWith(null);
    onNarrow.mockClear();
    fireEvent.click(screen.getByRole('button', { name: S.log.showAll }));
    expect(onNarrow).toHaveBeenLastCalledWith(null);
  });

  it('저장소 칸이 없는 줄(저장소 탭)은 예전 모양 그대로다. 줄이 없으면 안내 문구', () => {
    const { rerender } = render(<CommandLogView rows={[{ record: record(1) }]} emptyText="x" />);
    const [row] = consoleRows();
    expect(row?.dataset.repo).toBeUndefined();
    expect(
      within(row as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['git push', S.log.copy]);
    rerender(<CommandLogView rows={[]} emptyText={S.log.empty} />);
    expect(screen.getByText(S.log.empty)).toBeTruthy();
  });
});

describe('폴더 탭의 콘솔 (W19 ②)', () => {
  it('처음에는 읽기 명령이 보이지 않는다는 빈 안내. 일괄 push 뒤 실패가 콘솔 탭에 표시되고, 콘솔을 열면 저장소별 줄이 보이며 표시가 사라진다', async () => {
    const { folder } = await mountFolder();
    act(() => fireEvent.click(consoleTab()));
    await tick();
    expect(screen.getByText(S.log.folderEmpty)).toBeTruthy();
    // 로그 탭에 있는 동안 push: web-console 이 거부된다
    act(() => useAppStore.getState().setGitDockTab('log'));
    await act(async () => {
      await folder()?.getState().runBatch({ kind: 'push' }, [AUTH, WEB]);
    });
    await tick();
    // 보이는 글자는 수, 보조 기술에는 탭 이름은 "콘솔" 그대로이고 문장은 탭의 설명으로 읽힌다 (W19 ③)
    expect(consoleTab().textContent).toBe(`${S.dock.tabs.console}1${S.log.unseenFailures(1)}`);
    expect(consoleTab().getAttribute('aria-label')).toBe(S.dock.tabs.console);
    const described = consoleTab().getAttribute('aria-describedby');
    expect(described && document.getElementById(described)?.textContent).toBe(
      S.log.unseenFailures(1),
    );

    act(() => fireEvent.click(consoleTab()));
    await tick();
    expect(consoleTab().textContent).toBe(S.dock.tabs.console);
    expect(folder()?.getState().commandLogUnseenFailures).toBe(0);
    const rows = consoleRows();
    expect(rows.map((r) => [r.querySelector('button')?.textContent, r.dataset.failed])).toEqual([
      ['web-console', 'true'],
      ['auth-service', 'false'],
    ]);
  });

  it('저장소 칸으로 좁히면 그 저장소의 줄만 보이고, 로그 탭에 갔다 와도 좁힘과 기록이 남는다', async () => {
    const { folder } = await mountFolder();
    await act(async () => {
      await folder()?.getState().runBatch({ kind: 'push' }, [AUTH, WEB]);
      await folder()?.getState().runBatch({ kind: 'fetch', prune: true }, [AUTH, WEB]);
    });
    act(() => useAppStore.getState().setGitDockTab('console'));
    await tick();
    expect(consoleRows()).toHaveLength(4);
    act(() =>
      fireEvent.click(
        within(consoleRows()[1] as HTMLElement).getByRole('button', { name: 'auth-service' }),
      ),
    );
    await tick();
    expect(consoleRows().map((r) => r.querySelector('button')?.textContent)).toEqual([
      'auth-service',
      'auth-service',
    ]);
    expect(screen.getByText(S.log.narrowed('auth-service'))).toBeTruthy();

    act(() => useAppStore.getState().setGitDockTab('log'));
    await tick();
    act(() => useAppStore.getState().setGitDockTab('console'));
    await tick();
    expect(consoleRows()).toHaveLength(2);
    act(() => fireEvent.click(screen.getByRole('button', { name: S.log.showAll })));
    await tick();
    expect(consoleRows()).toHaveLength(4);
  });
});

describe('저장소 탭의 콘솔은 그대로다', () => {
  it('그 세션의 기록을 저장소 칸 없이 보인다 (읽기 기록 포함)', async () => {
    const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
    const opened = await mock.openRepo(WEB, () => {});
    const id = opened.session;
    const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
    registerSession(id, { cache, store: createSessionStore(opened, mock, cache) });
    getSessionStore(id)?.setState({
      log: [record(2, { args: ['status'], isWrite: false }), record(1)],
    });
    act(() =>
      useAppStore.setState({
        sessions: { [id]: { id, kind: 'repo', path: WEB, name: 'web-console', parent: null } },
        sessionOrder: [id],
        activeSessionId: id,
        dock: { tool: 'git', maximized: false, gitTab: 'console' },
        client: mock,
      }),
    );
    render(<App />);
    await tick();
    const rows = consoleRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.dataset.repo === undefined)).toBe(true);
    expect(rows[0]?.textContent).toContain(S.log.read);
    expect(consoleTab().textContent).toBe(S.dock.tabs.console);
  });
});
