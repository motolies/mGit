import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, type SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { opSlotColumn } from '../features/workspace/op-band';
import { getFolderStore, getSessionStore, getWorkspaceStore, useAppStore } from '../store';
import { DEFAULT_DOCK, type LeftTool } from '../store/app-store';
import { createFolderStore } from '../store/folder-store';
import { notifyHub } from '../store/notify';
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

// 목 폴더 장면: catalog-service 가 rebase 중 충돌 하나. 조절값 1 이면 billing-service 가 merge 중 충돌 둘
const FOLDER = '/mock/acme-platform';
const API = `${FOLDER}/api-gateway`;
const AUTH = `${FOLDER}/auth-service`;
const BILLING = `${FOLDER}/billing-service`;
const CATALOG = `${FOLDER}/catalog-service`;
const WEB = `${FOLDER}/web-console`;
const FACET = 'src/search/facets/FacetBuilder.kt';

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

/** 폴더 탭을 등록하고 앱 전체를 그린다 (앱 스토어 `openFolderAt` 이 워크스페이스에 주입하는 것과 같은 의존) */
async function mountFolder(folderOps = 0, leftTool: LeftTool = 'commit') {
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
      leftTool,
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

/** 작업 진행 띠 */
const band = () => screen.queryByRole('region', { name: S.opBand.label });
/** 띠에서 그 저장소의 줄 */
function bandRow(name: string): HTMLElement {
  const area = band();
  const found = [...(area?.children ?? [])].find((r) => r.textContent?.includes(name));
  if (!(found instanceof HTMLElement)) {
    throw new Error(`띠 줄 없음: ${name}`);
  }
  return found;
}
/** 열린 대화상자 */
const dialog = () => document.querySelector<HTMLElement>('dialog[open]');
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
/** 누르고 처리가 끝나기를 기다린다 */
async function click(el: HTMLElement) {
  act(() => {
    fireEvent.click(el);
  });
  await tick();
  await tick();
}

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

describe('작업 진행 띠 (WS-10)', () => {
  it('진행 중인 저장소 한 줄: 저장소 이름·작업·충돌 수, 충돌이 남았으면 Continue 가 꺼지고 사유가 보인다. 세션은 아직 열지 않는다', async () => {
    const { mock } = await mountFolder();
    const open = vi.spyOn(mock, 'folderOpenRepoSession');
    const row = bandRow('catalog-service');
    expect(band()?.children).toHaveLength(1);
    expect(row.textContent).toContain('REBASING');
    expect(within(row).getByRole('button', { name: /충돌 1/ })).toBeTruthy();
    const cont = within(row).getByRole('button', { name: S.op.continueLabel }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(cont.parentElement?.getAttribute('title')).toBe(S.opBand.continueBlocked(1));
    expect(row.textContent).toContain(S.op.conflicts(1));
    // rebase 는 Skip 이 있다 (저장소 탭 배너와 같은 조건)
    expect(within(row).getByRole('button', { name: S.op.skip })).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
  });

  it('진행 중인 저장소가 여럿이면 줄이 늘어난다 (요약 순서)', async () => {
    await mountFolder(2);
    const rows = [...(band()?.children ?? [])].map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('billing-service');
    expect(rows[0]).toContain('MERGING');
    expect(rows[1]).toContain('catalog-service');
    expect(rows[2]).toContain('design-system');
    // cherry-pick 은 충돌이 없어 Continue 가 켜져 있다
    const cont = within(bandRow('design-system')).getByRole('button', {
      name: S.op.continueLabel,
    }) as HTMLButtonElement;
    expect(cont.disabled).toBe(false);
  });

  it('Abort 는 저장소 이름을 밝힌 확인창 뒤 그 줄의 저장소 세션에만 간다 — 활성 저장소가 다른 저장소여도. 끝나면 알리고 줄이 사라진다', async () => {
    const { mock, ws, session } = await mountFolder();
    const abort = vi.spyOn(mock, 'opAbort');
    // 다른 저장소(web)의 diff 탭을 보는 중이다
    await click(crow('orders.ts'));
    expect(ws()?.activeRepo).toBe(WEB);
    await click(within(bandRow('catalog-service')).getByRole('button', { name: S.op.abort }));
    expect(dialog()?.querySelector('h2')?.textContent).toBe(
      S.opBand.abortTitle('catalog-service', 'rebase'),
    );
    expect(dialog()?.textContent).toContain(S.opBand.abortMessage);
    // 취소하면 아무것도 하지 않는다
    await click(within(dialog() as HTMLElement).getByRole('button', { name: S.confirm.cancel }));
    expect(abort).not.toHaveBeenCalled();
    await click(within(bandRow('catalog-service')).getByRole('button', { name: S.op.abort }));
    act(() => {
      fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
    });
    await tick();
    await tick();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledWith(session(CATALOG));
    expect(session(CATALOG)).not.toBe(session(WEB));
    expect(band()).toBeNull();
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe(
      S.opBand.aborted('catalog-service', 'rebase'),
    );
  });

  it('실행 중에는 그 줄이 "실행 중" 이고 버튼이 꺼진다. 실패하면 사유가 줄에 남는다', async () => {
    const { mock } = await mountFolder(2);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const real = mock.opContinue.bind(mock);
    vi.spyOn(mock, 'opContinue').mockImplementation(async (s, allow) => {
      await gate;
      return real(s, allow);
    });
    const row = () => bandRow('design-system');
    act(() => {
      fireEvent.click(within(row()).getByRole('button', { name: S.op.continueLabel }));
    });
    await tick();
    expect(row().textContent).toContain(S.opBand.running);
    expect(
      (within(row()).getByRole('button', { name: S.op.abort }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      release();
      await gate;
    });
    await tick();
    await tick();
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe(
      S.opBand.finished('design-system', 'cherry-pick'),
    );
    expect(
      [...(band()?.children ?? [])].some((r) => r.textContent?.includes('design-system')),
    ).toBe(false);
    // 실패: 코어가 거부하면 그 사유가 줄에 남는다
    vi.spyOn(mock, 'opSkip').mockRejectedValue(new Error('rebase --skip 실패'));
    await click(within(bandRow('catalog-service')).getByRole('button', { name: S.op.skip }));
    expect(bandRow('catalog-service').textContent).toContain('rebase --skip 실패');
  });

  it('충돌을 모두 해결하면 Continue 가 켜지고, 누르면 그 저장소 세션에서 이어 가 작업이 끝난다', async () => {
    const { mock, id, session } = await mountFolder();
    const cont = vi.spyOn(mock, 'opContinue');
    await act(async () => {
      await useAppStore.getState().withRepoSession(id, CATALOG, () => {});
    });
    await act(async () => {
      await mock.resolveSide(session(CATALOG), FACET, 'ours');
    });
    await tick();
    const button = within(bandRow('catalog-service')).getByRole('button', {
      name: S.op.continueLabel,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(bandRow('catalog-service').textContent).toContain(S.op.noConflicts);
    await click(button);
    expect(cont).toHaveBeenCalledWith(session(CATALOG), false);
    expect(band()).toBeNull();
  });

  it('충돌 해결: 충돌 파일이 하나면 머지 편집기 탭을 열고, 여럿이면 Commit 도구 창의 그 저장소를 펼친다', async () => {
    const { ws } = await mountFolder(1, 'project');
    await click(within(bandRow('catalog-service')).getByRole('button', { name: S.opBand.resolve }));
    expect(ws()?.activeDocId).toBe(conflictDocId(CATALOG));
    // billing 은 충돌 둘 (충돌 수 버튼도 같은 동작이다). 접어 둔 저장소가 펼쳐진다
    act(() => ws()?.setCommitCollapsed([`r:${BILLING}`, `r:${CATALOG}`]));
    await click(within(bandRow('billing-service')).getByRole('button', { name: /충돌 2/ }));
    expect(useAppStore.getState().leftTool).toBe('commit');
    expect(ws()?.commitCollapsed).toEqual([`r:${CATALOG}`]);
  });

  it('여러 줄 띠: 같은 칸은 줄마다 같은 열이다 — merge 줄에 Skip 이 없고 충돌이 없는 줄에 충돌 해결이 없어도 Continue·Abort 열은 같다 (W19)', async () => {
    await mountFolder(2);
    /** 줄의 칸 → 열 번호 */
    const columns = (name: string) =>
      Object.fromEntries(
        [...bandRow(name).querySelectorAll<HTMLElement>('[data-slot]')].map((el) => [
          el.dataset.slot,
          el.style.gridColumn,
        ]),
      );
    const merge = columns('billing-service');
    const rebase = columns('catalog-service');
    const pick = columns('design-system');
    expect(merge.skip).toBeUndefined();
    expect(rebase.skip).toBe(String(opSlotColumn('skip')));
    expect(pick.resolve).toBeUndefined();
    expect(pick.count).toBeUndefined();
    for (const row of [merge, rebase, pick]) {
      expect(row.subject).toBe(String(opSlotColumn('subject')));
      expect(row.label).toBe(String(opSlotColumn('label')));
      expect(row.continue).toBe(String(opSlotColumn('continue')));
      expect(row.abort).toBe(String(opSlotColumn('abort')));
    }
  });

  it('충돌 해결(여럿)은 Commit 도구 창을 열어 그 저장소 줄을 고르고 그 줄까지 스크롤하게 한다 (W19)', async () => {
    const { ws } = await mountFolder(1, 'project');
    await click(within(bandRow('billing-service')).getByRole('button', { name: S.opBand.resolve }));
    expect(useAppStore.getState().leftTool).toBe('commit');
    // 트리가 요청대로 그 저장소 줄을 고르고 알렸다 (요청이 비었다)
    expect(crow('billing-service').getAttribute('aria-selected')).toBe('true');
    expect(ws()?.commitReveal).toBeNull();
  });

  it('충돌 편집 초안이 있는 채 띠에서 Abort 하면 "밖에서 해결" 이 아니라 중단한 사유로 알린다 (W19)', async () => {
    // 세션 스토어의 알림은 앱이 시작할 때(`bootstrap`) 토스트로 이어진다 — 여기서 같은 길을 잇는다
    const before = notifyHub.setHandler((n) => useAppStore.getState().notice(n));
    try {
      const { id, session } = await mountFolder();
      await act(async () => {
        await useAppStore.getState().withRepoSession(id, CATALOG, () => {});
      });
      act(() =>
        getSessionStore(session(CATALOG))
          ?.getState()
          .setConflictDraft(FACET, { text: 'mine', ranges: [], key: 'k' }),
      );
      await click(within(bandRow('catalog-service')).getByRole('button', { name: S.op.abort }));
      act(() => {
        fireEvent.submit(dialog()?.querySelector('form') as HTMLFormElement);
      });
      await tick();
      await tick();
      const titles = useAppStore.getState().toasts.map((t) => t.title);
      expect(titles).toContain(S.conflict.droppedByAbort(FACET));
      expect(titles).not.toContain(S.conflict.externallyResolved(FACET));
      expect(titles.at(-1)).toBe(S.opBand.aborted('catalog-service', 'rebase'));
      expect(getSessionStore(session(CATALOG))?.getState().conflictDrafts).toEqual({});
    } finally {
      notifyHub.setHandler(before);
    }
  });

  it('세션 상한(3개)이 모두 바쁘면 세션이 없는 줄은 실행할 수 없고 사유가 보인다', async () => {
    const { id, session } = await mountFolder();
    // 셋을 연 뒤에 바쁘게 한다 (도는 쓰기는 활성 저장소를 잠가 그사이 다른 저장소를 열 수 없다)
    for (const repo of [API, AUTH, WEB]) {
      await act(async () => {
        await useAppStore.getState().withRepoSession(id, repo, () => {});
      });
    }
    for (const repo of [API, AUTH, WEB]) {
      act(() => getSessionStore(session(repo))?.setState({ busy: true }));
    }
    await tick();
    const row = bandRow('catalog-service');
    expect(row.textContent).toContain(S.opBand.limit(3));
    expect(
      (within(row).getByRole('button', { name: S.op.abort }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(row).getByRole('button', { name: S.op.skip }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
