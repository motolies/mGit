import { createNullClient } from '@mgit/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppStore, type SessionMeta } from '../store/app-store';
import { useFileCloseStore } from '../store/file-editor-close';
import { fileEditors } from '../store/file-editor-store';
import { sessionCloseTargets } from '../store/session-close';
import { clearSessionRegistry, registerSession } from '../store/session-registry';

const sessions: Record<number, SessionMeta> = {
  1: { id: 1, kind: 'folder', name: 'folder', path: '/f', parent: null },
  2: { id: 2, kind: 'repo', name: 'child-a', path: '/f/a', parent: 1 },
  3: { id: 3, kind: 'repo', name: 'child-b', path: '/f/b', parent: 1 },
  4: { id: 4, kind: 'repo', name: 'other', path: '/r', parent: null },
};
const order = [1, 2, 3, 4];

/** 저장소 상태만 바꿀 수 있는 경량 장부로 닫기 대상을 검증한다. */
function setup() {
  const closeRepo = vi.fn(async () => {});
  const closeFolder = vi.fn(async () => {});
  const store = createAppStore({
    client: { ...createNullClient(), closeRepo, closeFolder },
    pickDirectory: async () => null,
  });
  store.setState({ sessions: { ...sessions }, sessionOrder: [...order], activeSessionId: 4 });
  const states = new Map<
    number,
    { busy: boolean; conflictDrafts: Record<string, { text: string }>; rewordEditor?: unknown }
  >();
  for (const id of [2, 3, 4]) {
    const state = { busy: false, conflictDrafts: {} };
    states.set(id, state);
    registerSession(id, {
      cache: { dispose() {} } as never,
      store: {
        subscribe: () => () => {},
        getState: () => ({
          ...states.get(id),
          status: { summary: { conflicted: 0 } },
          fileTree: { subscribe: () => () => {} },
        }),
      } as never,
    });
  }
  return { store, states, closeRepo, closeFolder };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionRegistry();
  useFileCloseStore.setState({ pending: null });
});

describe('상단 탭 닫기 집합', () => {
  it('child 보존은 부모를 포함하고 folder 보존은 child를 닫는다', () => {
    expect(sessionCloseTargets(order, sessions, 2, 'others')).toEqual([3, 4]);
    expect(sessionCloseTargets(order, sessions, 1, 'others')).toEqual([2, 3, 4]);
    expect(sessionCloseTargets(order, sessions, 1, 'this')).toEqual([1, 2, 3]);
    expect(sessionCloseTargets(order, sessions, 2, 'all')).toEqual(order);
  });

  it('작업 중 child와 부모는 보존하고 나머지를 닫는다', async () => {
    const { store, states, closeRepo, closeFolder } = setup();
    const busy = states.get(2);
    if (busy) busy.busy = true;
    await store.getState().requestCloseTabs(4, 'all');
    expect(store.getState().sessionOrder).toEqual([1, 2]);
    expect(closeRepo.mock.calls).toEqual([[3], [4]]);
    expect(closeFolder).not.toHaveBeenCalled();
  });

  it('초안 확인 취소는 모든 탭을 그대로 유지하고 중복 요청은 확인을 덮지 않는다', async () => {
    const { store, states } = setup();
    const state = states.get(3);
    if (state) state.conflictDrafts = { 'a.txt': { text: 'draft' } };
    await store.getState().requestCloseTabs(2, 'others');
    const pending = store.getState().closeTabsPending;
    expect(pending?.targets).toEqual([3, 4]);
    await store.getState().requestCloseTabs(1, 'all');
    expect(store.getState().closeTabsPending).toBe(pending);
    store.getState().cancelCloseSession();
    expect(store.getState().sessionOrder).toEqual(order);
    expect(store.getState().closeTabsRunning).toBe(false);
  });

  it('확인 뒤 바뀐 초안은 다시 확인하고 새로 열린 child는 부모와 함께 보존한다', async () => {
    const { store, states } = setup();
    const state = states.get(3);
    if (state) state.conflictDrafts = { 'a.txt': { text: 'first' } };
    await store.getState().requestCloseTabs(1, 'all');
    if (state) state.conflictDrafts['a.txt'] = { text: 'changed' };
    await store.getState().confirmCloseSession();
    expect(store.getState().sessionOrder).toEqual(order);
    store.setState({
      sessions: {
        ...store.getState().sessions,
        5: { id: 5, kind: 'repo', name: 'new-child', path: '/f/new', parent: 1 },
      },
      sessionOrder: [...order, 5],
    });
    await store.getState().confirmCloseSession();
    expect(store.getState().sessionOrder).toEqual([...order, 5]);
    await store.getState().confirmCloseSession();
    expect(store.getState().sessionOrder).toEqual([1, 5]);
  });

  it('저장 실패에서 취소하면 확인 전후 어느 탭도 닫지 않는다', async () => {
    const { store, closeRepo, closeFolder } = setup();
    vi.spyOn(fileEditors, 'flush').mockResolvedValue(false);
    const closing = store.getState().requestCloseTabs(4, 'all');
    await vi.waitFor(() => expect(useFileCloseStore.getState().pending).not.toBeNull());
    useFileCloseStore.getState().choose('cancel');
    await closing;
    expect(store.getState().sessionOrder).toEqual(order);
    expect(closeRepo).not.toHaveBeenCalled();
    expect(closeFolder).not.toHaveBeenCalled();
  });

  it('확인 뒤 저장 대기 중 새 작업이 시작되면 해당 탭과 부모를 남긴다', async () => {
    const { store, states } = setup();
    let finish!: (ok: boolean) => void;
    vi.spyOn(fileEditors, 'flush')
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(true);
    const closing = store.getState().requestCloseTabs(4, 'all');
    const state = states.get(2);
    if (state) state.rewordEditor = { phase: 'loading' };
    finish(true);
    await closing;
    expect(store.getState().sessionOrder).toEqual([1, 2]);
  });
});
