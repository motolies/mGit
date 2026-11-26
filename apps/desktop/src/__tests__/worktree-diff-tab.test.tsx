import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, type RepoChanges, type SessionEvent, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { getFolderStore, getSessionStore, getWorkspaceStore, useAppStore } from '../store';
import { DEFAULT_DOCK } from '../store/app-store';
import { createFolderStore } from '../store/folder-store';
import { activeRepoLocked } from '../store/repo-sessions';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  registerFolder,
  registerWorkspace,
} from '../store/session-registry';
import { createWorkspaceStore, worktreeDiffDocId } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (_props: GraphViewProps) => <div data-testid="graph-view" />,
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 3000 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

// 목 폴더 장면
const FOLDER = '/mock/acme-platform';
const AUTH = `${FOLDER}/auth-service`;
const WEB = `${FOLDER}/web-console`;
const ORDERS = 'apps/console/src/shared/api/orders.ts';
const YAML = 'src/main/resources/config/rate-limit.yaml';

const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/** 앱 스토어의 활성 저장소 잠금과 같은 판정 (범위 세션이 바쁘거나 여는 중) */
function locked(folder: SessionId): boolean {
  const app = useAppStore.getState();
  const active = getWorkspaceStore(folder)?.getState().activeRepo ?? null;
  const entry = active === null ? undefined : app.repoSessions[folder]?.[active];
  return activeRepoLocked({
    opening: app.repoSessionOpening[folder] !== undefined,
    scope: (entry ? getSessionStore(entry.session)?.getState() : undefined) ?? null,
  });
}

/** 폴더 탭(Commit 도구 창이 열린 상태)을 등록하고 앱 전체를 그린다 */
async function mountFolder(
  mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 }),
) {
  const opened = await mock.openFolder(FOLDER, (e) =>
    getFolderStore(e.session)?.getState().applyEvent(e),
  );
  const id = opened.session;
  mounted.push(id);
  registerFolder(id, createFolderStore(opened, mock));
  // 앱 스토어의 `openFolderAt` 이 워크스페이스에 주입하는 것과 같은 의존: 활성 저장소 잠금, diff 탭 닫기
  registerWorkspace(
    id,
    createWorkspaceStore('folder', {
      activeRepoLocked: () => locked(id),
      closeSessionDoc: (doc) => useAppStore.getState().closeRepoDiff(id, doc.repoPath),
    }),
  );
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'folder', path: FOLDER, name: 'acme-platform', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool: 'commit',
      client: mock,
      repoSessions: {},
      repoSessionOpening: {},
      toasts: [],
    }),
  );
  render(<App />);
  await tick();
  await tick();
  const ws = () => getWorkspaceStore(id)?.getState();
  const session = (repo: string) => useAppStore.getState().repoSessions[id]?.[repo]?.session ?? -1;
  return { mock, id, ws, session };
}

/** 변경 트리에서 그 이름의 줄 */
function crow(name: string): HTMLElement {
  const area = document.querySelector<HTMLElement>('[data-panel="commit"]') as HTMLElement;
  const found = within(area)
    .getAllByRole('treeitem')
    .find((r) => [...r.querySelectorAll('span')].some((s) => s.textContent === name));
  if (!found) {
    throw new Error(`줄 없음: ${name}`);
  }
  return found;
}
/** 파일 줄을 눌러 diff 탭을 연다 */
async function openRow(name: string) {
  act(() => {
    fireEvent.click(crow(name));
  });
  await tick();
  await tick();
}
/** 에디터 공간 */
const editor = () => within(document.querySelector('[data-panel="editor"]') as HTMLElement);
/** 에디터 탭 글자 (제목 + 보조 글자) */
const tabs = () =>
  editor()
    .getAllByRole('tab')
    .map((t) => t.textContent);
/** 키를 누른다 */
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(document.body, { key, ...init });
  });

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

describe('작업 트리 diff 탭 (ED-05, 저장소당 하나)', () => {
  it('제목은 파일 이름 + 저장소 이름. 같은 저장소의 다른 파일은 같은 탭, 다른 저장소는 탭이 하나 더. 세션은 저장소마다 한 번만 연다', async () => {
    const { mock, id } = await mountFolder();
    const open = vi.spyOn(mock, 'folderOpenRepoSession');
    await openRow('orders.ts');
    expect(tabs()).toEqual([S.workspace.overview, 'orders.tsweb-console']);
    expect(editor().getByRole('tab', { selected: true }).textContent).toBe('orders.tsweb-console');
    // diff 화면: 그 파일·작업 트리 쪽, "← 그래프로" 대신 탭 닫기를 쓴다
    expect(editor().getByText(ORDERS)).toBeTruthy();
    expect(editor().getByText(S.diff.unstagedLabel)).toBeTruthy();
    expect(editor().queryByText(`← ${S.diff.back}`)).toBeNull();

    await openRow('ko.json');
    expect(tabs()).toEqual([S.workspace.overview, 'ko.jsonweb-console']);
    await openRow('rate-limit.yaml');
    expect(tabs()).toEqual([
      S.workspace.overview,
      'ko.jsonweb-console',
      'rate-limit.yamlauth-service',
    ]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls.map((c) => c[1])).toEqual([WEB, AUTH]);
    // 다시 열어도 새로 열지 않는다
    await openRow('orders.ts');
    expect(open).toHaveBeenCalledTimes(2);
    expect(getWorkspaceStore(id)?.getState().activeRepo).toBe(WEB);
  });

  it('stage 는 화면에 보이는 그 파일·그 저장소 세션에만 닿는다 — 활성 저장소가 다른 저장소로 잠겨 있어도', async () => {
    const { mock, ws, session } = await mountFolder();
    const stageLines = vi.spyOn(mock, 'stageLines');
    await openRow('rate-limit.yaml');
    await openRow('orders.ts');
    expect(ws()?.activeRepo).toBe(WEB);
    // web 의 세션이 바쁘다 → 활성 저장소 잠금
    act(() => getSessionStore(session(WEB))?.setState({ busy: true }));
    act(() => {
      fireEvent.click(
        editor()
          .getAllByRole('tab')
          .find((t) => t.textContent === 'rate-limit.yamlauth-service') as HTMLElement,
      );
    });
    await tick();
    expect(ws()?.activeDocId).toBe(worktreeDiffDocId(AUTH));
    expect(ws()?.activeRepo).toBe(WEB);
    expect(editor().getByText(YAML)).toBeTruthy();

    act(() => {
      fireEvent.click(editor().getByText(S.diff.applyHunk(S.diff.stage)));
    });
    await tick();
    expect(stageLines).toHaveBeenCalledTimes(1);
    expect(stageLines).toHaveBeenCalledWith(
      session(AUTH),
      YAML,
      [{ hunk: 0, lines: [] }],
      false,
      expect.anything(),
      expect.stringMatching(/^mock:/),
    );
    expect(stageLines.mock.calls.some((c) => c[0] === session(WEB))).toBe(false);
  });

  it('되돌리기는 확인창을 거치고 제목에 저장소 이름이 있다. 그 저장소 세션에만 닿는다', async () => {
    const { mock, session } = await mountFolder();
    const discard = vi.spyOn(mock, 'discardLines');
    await openRow('rate-limit.yaml');
    await openRow('orders.ts');
    act(() => {
      fireEvent.click(editor().getByText(S.diff.discardHunk));
    });
    await tick();
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]') as HTMLDialogElement;
    expect(dialog.querySelector('h2')?.textContent).toBe(
      S.diff.discardTitleIn('web-console', ORDERS),
    );
    act(() => fireEvent.click(within(dialog).getByRole('button', { name: S.confirm.cancel })));
    await tick();
    expect(discard).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(editor().getByText(S.diff.discardHunk));
    });
    await tick();
    act(() => {
      fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement);
    });
    await tick();
    expect(discard).toHaveBeenCalledWith(
      session(WEB),
      ORDERS,
      [{ hunk: 0, lines: [] }],
      expect.anything(),
      expect.stringMatching(/^mock:/),
    );
  });

  it('되돌리기 확인 중 파일이 바뀌면 기존 파일과 새 파일 모두 수정하지 않는다', async () => {
    const { mock, session } = await mountFolder();
    const discard = vi.spyOn(mock, 'discardLines');
    await openRow('orders.ts');
    act(() => fireEvent.click(editor().getByText(S.diff.discardHunk)));
    await tick();
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]') as HTMLDialogElement;
    expect(dialog.textContent).toContain('스테이징 영역');
    expect(dialog.textContent).toContain('작업 파일');
    const store = getSessionStore(session(WEB));
    await act(async () => {
      await store?.getState().openFile('different.ts', false);
    });
    act(() =>
      fireEvent.submit(
        within(dialog)
          .getByRole('button', { name: S.diff.discardConfirm })
          .closest('form') as HTMLFormElement,
      ),
    );
    await tick();
    expect(discard).not.toHaveBeenCalled();
    expect(store?.getState().actionError).toBe(S.diff.staleSelection);
  });

  it('되돌리기 확인 중 revision이 바뀌면 오류를 표시하고 실행하지 않는다', async () => {
    const { mock, session } = await mountFolder();
    const discard = vi.spyOn(mock, 'discardLines');
    await openRow('orders.ts');
    act(() => fireEvent.click(editor().getByText(S.diff.discardHunk)));
    await tick();
    const store = getSessionStore(session(WEB));
    const doc = store?.getState().diffDocument;
    act(() => {
      if (doc) store?.setState({ diffDocument: { ...doc, revision: 'external-edit' } });
    });
    act(() => fireEvent.submit(document.querySelector('dialog[open] form') as HTMLFormElement));
    await tick();
    expect(discard).not.toHaveBeenCalled();
    expect(store?.getState().actionError).toBe(S.diff.staleSelection);
  });

  it('Esc·탭 닫기는 그 문서의 저장소 세션 슬롯을 비워 탭을 닫는다 (다른 저장소의 탭은 그대로)', async () => {
    const { ws, session } = await mountFolder();
    await openRow('rate-limit.yaml');
    await openRow('orders.ts');
    press('Escape');
    await tick();
    expect(getSessionStore(session(WEB))?.getState().selectedFile).toBeNull();
    expect(ws()?.sessionDocs.map((d) => d.id)).toEqual([worktreeDiffDocId(AUTH)]);
    // 직전에 보던 auth 의 탭으로 돌아간다
    expect(ws()?.activeDocId).toBe(worktreeDiffDocId(AUTH));
    act(() => {
      fireEvent.click(
        editor().getByRole('button', { name: S.workspace.closeTab('rate-limit.yaml') }),
      );
    });
    await tick();
    expect(getSessionStore(session(AUTH))?.getState().selectedFile).toBeNull();
    expect(tabs()).toEqual([S.workspace.overview]);
  });

  it('일부만 stage 된 파일은 staged·작업 트리 diff 를 바꿔 볼 수 있다', async () => {
    const { mock } = await mountFolder();
    const diff = vi.spyOn(mock, 'workTreeDiffDocument');
    await openRow('StatusFilter.tsx');
    const group = editor().getByRole('group', { name: S.workspace.diffArea });
    act(() => {
      fireEvent.click(within(group).getByRole('button', { name: S.diff.stagedLabel }));
    });
    await tick();
    expect(diff).toHaveBeenLastCalledWith(
      expect.any(Number),
      'apps/console/src/pages/orders/filters/StatusFilter.tsx',
      true,
      false,
      expect.anything(),
    );
    // 한쪽에만 변경이 있는 파일은 전환이 없다
    await openRow('orders.ts');
    expect(editor().queryByRole('group', { name: S.workspace.diffArea })).toBeNull();
  });

  it('diff 탭에서 hunk 를 stage 하면 세션의 상태 변경이 폴더 변경을 다시 읽게 해 그 파일의 체크가 중간이 된다', async () => {
    // 목은 세션 쓰기로 상태를 바꾸지 않는다: hunk stage 뒤 코어가 낼 것(세션의 statusChanged, 그 저장소 변경 목록의
    // MM)을 흉내 낸다
    const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
    const channels = new Map<string, (e: SessionEvent) => void>();
    const openReal = mock.folderOpenRepoSession.bind(mock);
    vi.spyOn(mock, 'folderOpenRepoSession').mockImplementation((folder, repo, onEvent) => {
      channels.set(repo, onEvent);
      return openReal(folder, repo, onEvent);
    });
    let staged = false;
    const changesReal = mock.folderChanges.bind(mock);
    vi.spyOn(mock, 'folderChanges').mockImplementation(async (s, repos) => {
      const rows: RepoChanges[] = await changesReal(s, repos);
      return staged
        ? rows.map((r) => ({
            ...r,
            entries: r.entries.map((e) =>
              e.path === ORDERS ? { ...e, index: 'modified' as const } : e,
            ),
          }))
        : rows;
    });
    vi.spyOn(mock, 'stageLines').mockImplementation(async (session) => {
      staged = true;
      const st = getSessionStore(session)?.getState();
      if (st) {
        channels.get(WEB)?.({
          type: 'statusChanged',
          session,
          status: {
            ...st.status,
            entries: st.status.entries.map((e) =>
              e.path === ORDERS ? { ...e, index: 'modified' as const } : e,
            ),
          },
          op: null,
        });
      }
    });
    await mountFolder(mock);
    expect(crow('orders.ts').getAttribute('aria-checked')).toBe('false');
    await openRow('orders.ts');
    act(() => {
      fireEvent.click(editor().getByText(S.diff.applyHunk(S.diff.stage)));
    });
    // 폴더 스토어의 부분 갱신 디바운스(400ms) 뒤에 그 저장소만 다시 읽는다
    await act(() => new Promise<void>((r) => setTimeout(r, 450)));
    await tick();
    expect(crow('orders.ts').getAttribute('aria-checked')).toBe('mixed');
    // 작업 트리 쪽 변경이 남았으므로 탭은 그대로다
    expect(tabs()).toEqual([S.workspace.overview, 'orders.tsweb-console']);
  });
});
