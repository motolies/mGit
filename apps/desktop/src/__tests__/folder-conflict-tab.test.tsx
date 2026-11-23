import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
import { conflictDocId, createWorkspaceStore } from '../store/workspace-store';
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

// 목 폴더 장면: catalog-service 가 rebase 중 충돌 하나. 조절값 1 이면 billing-service 가 merge 중 충돌 둘(텍스트·삭제)
const FOLDER = '/mock/acme-platform';
const BILLING = `${FOLDER}/billing-service`;
const CATALOG = `${FOLDER}/catalog-service`;
const WEB = `${FOLDER}/web-console`;
const FACET = 'src/search/facets/FacetBuilder.kt';
const LIMITS = 'docs/billing-limits.md';

const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/** 앱 스토어의 활성 저장소 잠금과 같은 판정 */
function locked(folder: SessionId): boolean {
  const app = useAppStore.getState();
  const active = getWorkspaceStore(folder)?.getState().activeRepo ?? null;
  const entry = active === null ? undefined : app.repoSessions[folder]?.[active];
  return activeRepoLocked({
    opening: app.repoSessionOpening[folder] !== undefined,
    scope: (entry ? getSessionStore(entry.session)?.getState() : undefined) ?? null,
  });
}

/** 폴더 탭(Commit 도구 창이 열린 상태)을 등록하고 앱 전체를 그린다. 워크스페이스 의존은 앱 스토어와 같다 */
async function mountFolder(folderOps = 0) {
  const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0, folderOps });
  const opened = await mock.openFolder(FOLDER, (e) =>
    getFolderStore(e.session)?.getState().applyEvent(e),
  );
  const id = opened.session;
  mounted.push(id);
  registerFolder(id, createFolderStore(opened, mock));
  registerWorkspace(
    id,
    createWorkspaceStore('folder', {
      activeRepoLocked: () => locked(id),
      closeSessionDoc: (doc) =>
        doc.kind === 'conflict'
          ? useAppStore.getState().closeRepoConflict(id, doc.repoPath)
          : useAppStore.getState().closeRepoDiff(id, doc.repoPath),
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
  const session = (repo: string) => useAppStore.getState().repoSessions[id]?.[repo]?.session ?? -1;
  return { mock, id, session, ws: () => getWorkspaceStore(id)?.getState() };
}

/** Commit 도구 창의 그 이름 줄 */
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
/** 에디터 공간 */
const editor = () => within(document.querySelector('[data-panel="editor"]') as HTMLElement);
/** 에디터 탭 글자 (제목 + 보조 글자) */
const tabs = () =>
  editor()
    .getAllByRole('tab')
    .map((t) => t.textContent);
/** 열린 대화상자 */
const dialog = () => document.querySelector<HTMLElement>('dialog[open]');
/** 작업 진행 띠의 그 저장소 줄 */
const bandRow = (name: string) =>
  [...(screen.getByRole('region', { name: S.opBand.label }).children ?? [])].find((r) =>
    r.textContent?.includes(name),
  ) as HTMLElement;
/** 누르고 처리가 끝나기를 기다린다 */
async function click(el: HTMLElement) {
  act(() => {
    fireEvent.click(el);
  });
  await tick();
  await tick();
}
/** 키를 누른다. 기본 동작이 막히지 않았으면 참 (`dispatchEvent` 의 결과) */
function press(key: string, target: Element = document.body): boolean {
  let notPrevented = true;
  act(() => {
    notPrevented = fireEvent.keyDown(target, { key });
  });
  return notPrevented;
}
/** 편집기에서 모두 ours 를 고른다 (초안이 생긴다) */
const pickAllOurs = () => click(editor().getByRole('button', { name: S.conflict.allOurs }));

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
      conflictLeave: null,
      folderCloseConfirm: null,
    }),
  );
  for (const id of mounted) {
    disposeFolder(id);
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('폴더 탭의 충돌 머지 편집기 탭 (ED-06)', () => {
  it('Commit 도구 창에서 충돌 파일을 누르면 그 저장소의 충돌 탭이 고정 탭으로 뜬다. 제목은 파일 + 저장소 이름, "← 목록으로" 는 없다', async () => {
    const { mock, ws } = await mountFolder();
    const open = vi.spyOn(mock, 'folderOpenRepoSession');
    await click(crow('FacetBuilder.kt'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(tabs()).toEqual([S.workspace.overview, 'FacetBuilder.ktcatalog-service']);
    expect(ws()?.sessionDocs.map((d) => [d.id, d.pinned])).toEqual([
      [conflictDocId(CATALOG), true],
    ]);
    expect(editor().getByText(FACET)).toBeTruthy();
    expect(editor().getByRole('button', { name: S.conflict.save })).toBeTruthy();
    expect(editor().queryByText(`← ${S.conflict.back}`)).toBeNull();
    // 가벼운 세션이 읽은 머지 도구 (W15 의 STARTUP_LOADS) 가 머리줄에 있다
    expect(editor().getByRole('button', { name: S.assist.mergetool('meld') })).toBeTruthy();
  });

  it('저장은 화면에 보이는 그 파일·그 저장소 세션에만 닿는다 — 활성 저장소가 다른 저장소로 잠겨 있어도. 저장하면 탭이 닫히고 Commit 창의 충돌 표시가 풀리며 띠의 Continue 가 켜진다', async () => {
    const { mock, ws, session } = await mountFolder();
    const resolve = vi.spyOn(mock, 'resolveFile');
    await click(crow('FacetBuilder.kt'));
    await click(crow('orders.ts'));
    expect(ws()?.activeRepo).toBe(WEB);
    // web 의 세션에서 쓰기가 돈다 → 활성 저장소 잠금
    act(() => getSessionStore(session(WEB))?.setState({ busy: true }));
    await click(
      editor()
        .getAllByRole('tab')
        .find((t) => t.textContent === 'FacetBuilder.ktcatalog-service') as HTMLElement,
    );
    expect(ws()?.activeDocId).toBe(conflictDocId(CATALOG));
    expect(ws()?.activeRepo).toBe(WEB);
    await pickAllOurs();
    // 초안이 생겨 탭에 표시된다
    expect(tabs()).toContain(
      `${S.workspace.conflictTitle('FacetBuilder.kt', true)}catalog-service`,
    );
    await click(editor().getByRole('button', { name: S.conflict.saveDirty }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toBe(session(CATALOG));
    expect(resolve.mock.calls[0]?.[1]).toBe(FACET);
    expect(resolve.mock.calls.some((c) => c[0] === session(WEB))).toBe(false);
    // 해결되어 충돌 탭이 사라진다 (세션 상태 → 파생)
    expect(ws()?.sessionDocs.some((d) => d.kind === 'conflict')).toBe(false);
    // 폴더 변경을 다시 읽으면(디바운스 400ms) Commit 창의 충돌 표시가 풀리고 띠의 Continue 가 켜진다
    await act(() => new Promise<void>((r) => setTimeout(r, 450)));
    await tick();
    expect(crow('FacetBuilder.kt').getAttribute('aria-checked')).toBe('true');
    expect(
      (
        within(bandRow('catalog-service')).getByRole('button', {
          name: S.op.continueLabel,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it('초안이 있으면 X·Esc 로 닫기 전에 확인한다 (편집기 안의 Esc 는 편집기 몫). 닫아도 초안은 남아 다시 열면 복원된다', async () => {
    const { ws } = await mountFolder();
    await click(crow('FacetBuilder.kt'));
    await pickAllOurs();
    const title = S.workspace.conflictTitle('FacetBuilder.kt', true);
    // X
    await click(editor().getByRole('button', { name: S.workspace.closeTab(title) }));
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.conflictLeave.title(FACET));
    expect(dialog()?.textContent).toContain(S.conflictLeave.closeMessage('catalog-service'));
    await click(within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }));
    expect(ws()?.activeDocId).toBe(conflictDocId(CATALOG));
    // 편집기 안의 Esc 는 닫지 않는다
    press('Escape', document.querySelector('.cm-content') as Element);
    await tick();
    expect(dialog()).toBeNull();
    // 밖의 Esc 는 확인창. 그 키의 기본 동작을 막는다 — 막지 않으면 브라우저가 같은 Esc 로 방금 연 모달을 곧바로
    // 취소한다 (jsdom 은 닫기 요청을 흉내 내지 않아 기본 동작이 막혔는지로 확인한다, 브라우저에서 확인한 결함)
    expect(press('Escape')).toBe(false);
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.conflictLeave.title(FACET));
    act(() => {
      fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    });
    await tick();
    expect(ws()?.sessionDocs).toEqual([]);
    // 다시 열면 초안이 복원된다 (저장소 탭과 같은 동작)
    await click(crow('FacetBuilder.kt'));
    expect(editor().getByText(S.conflict.draftRestored)).toBeTruthy();
    expect(tabs()).toContain(`${title}catalog-service`);
  });

  it('초안이 있는 채로 폴더 탭을 닫으려 하면 저장소 이름과 경로를 밝힌 확인창이 뜬다 (WS-21)', async () => {
    const { id } = await mountFolder();
    await click(crow('FacetBuilder.kt'));
    await pickAllOurs();
    await act(async () => {
      await useAppStore.getState().requestCloseSession(id);
    });
    await tick();
    expect(dialog()?.querySelector('h2')?.textContent).toBe(S.folderClose.title('acme-platform'));
    expect(dialog()?.textContent).toContain(S.folderClose.draft('catalog-service', FACET));
    await click(within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }));
    expect(useAppStore.getState().sessions[id]).toBeDefined();
  });

  it('같은 저장소의 다른 충돌 파일로 바꾸면 초안이 있을 때 확인한다. 한쪽 고르기만 되는 삭제 충돌은 그 세션에 남기기/지우기', async () => {
    const { mock, session } = await mountFolder(1);
    const resolveDelete = vi.spyOn(mock, 'resolveDelete');
    await click(crow('InvoiceTotals.kt'));
    await pickAllOurs();
    await click(crow('billing-limits.md'));
    expect(dialog()?.textContent).toContain(
      S.conflictLeave.switchMessage('billing-service', LIMITS),
    );
    act(() => {
      fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    });
    await tick();
    await tick();
    // 탭은 하나 그대로, 내용이 삭제 충돌의 한쪽 고르기로 바뀐다
    expect(tabs()).toEqual([S.workspace.overview, 'billing-limits.mdbilling-service']);
    await click(editor().getByRole('button', { name: S.conflict.keepFile }));
    expect(resolveDelete).toHaveBeenCalledWith(session(BILLING), LIMITS, true);
  });
});
