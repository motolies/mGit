import { type AppEvent, createNullClient, type IpcClient } from '@mgit/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppStore, externalKey } from '../store/app-store';
import { clearSessionRegistry, registerSession } from '../store/session-registry';

/** 앱 이벤트를 직접 보낼 수 있는 스토어 */
async function setup(over: Partial<IpcClient> = {}) {
  let emit: (event: AppEvent) => void = () => {};
  const credentialReply = vi.fn(async () => {});
  const client: IpcClient = {
    ...createNullClient(),
    gitVersion: async () => ({ version: '2.50', path: 'git' }),
    openTabsGet: async () => [],
    takeStartupPaths: async () => [],
    subscribeAppEvents: async (cb: (event: AppEvent) => void) => {
      emit = cb;
    },
    credentialReply,
    ...over,
  } as IpcClient;
  const store = createAppStore({ client, pickDirectory: async () => null });
  await store.getState().bootstrap();
  await Promise.resolve();
  return { store, credentialReply, emit: (e: AppEvent) => emit(e) };
}

const ask = (reqId: number, target = 'https://a') =>
  ({ type: 'credentialRequested', reqId, kind: 'password', target, prompt: 'p' }) as AppEvent;

afterEach(() => {
  vi.useRealTimers();
  clearSessionRegistry();
});

describe('자격 증명 요청 큐', () => {
  it('뒤 요청이 앞 요청을 덮지 않고 차례로 나온다', async () => {
    const { store, emit, credentialReply } = await setup();
    emit(ask(1));
    emit(ask(2));
    expect(store.getState().credentialRequest?.reqId).toBe(1);
    await store.getState().replyCredential('one', false);
    expect(credentialReply).toHaveBeenCalledWith(1, 'one', false);
    expect(store.getState().credentialRequest?.reqId).toBe(2);
    await store.getState().replyCredential('two', true);
    expect(credentialReply).toHaveBeenCalledWith(2, 'two', true);
    expect(store.getState().credentialRequest).toBeNull();
  });

  it('코어가 포기한(5분) 요청은 대화상자에서 내리고 다음으로 넘어간다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { store, emit } = await setup();
    emit(ask(1));
    vi.advanceTimersByTime(4 * 60_000);
    emit(ask(2));
    vi.advanceTimersByTime(61_000);
    expect(store.getState().credentialRequest?.reqId).toBe(2);
    expect(store.getState().toasts.length).toBe(1);
    vi.advanceTimersByTime(4 * 60_000);
    expect(store.getState().credentialRequest).toBeNull();
  });

  it('큐에서 기다리다 이미 시간이 지난 요청은 건너뛴다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { store, emit } = await setup();
    emit(ask(1));
    emit(ask(2));
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(store.getState().credentialRequest).toBeNull();
  });

  it('요청받은 대상을 기억하고 저장된 자격 증명을 지운다', async () => {
    const credentialForget = vi.fn(async () => {});
    const { store, emit } = await setup({ credentialForget });
    emit(ask(1, 'https://github.com'));
    emit(ask(2, 'https://github.com'));
    expect(store.getState().credentialTargets).toEqual(['https://github.com']);
    expect(await store.getState().credentialForget('https://github.com')).toBe(true);
    expect(credentialForget).toHaveBeenCalledWith('https://github.com');
  });
});

describe('탭 닫기 보호', () => {
  /** 초안을 가진 세션을 등록한다 */
  function withDraft(store: Awaited<ReturnType<typeof setup>>['store'], id: number) {
    store.setState({
      sessions: { [id]: { id, kind: 'repo', path: '/r', name: 'r', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
    });
    registerSession(id, {
      cache: { dispose() {} } as never,
      store: {
        subscribe: () => () => {},
        getState: () => ({
          conflictDrafts: { 'a.txt': { text: 'x', ranges: [], key: 'k' } },
          fileTree: { subscribe: () => () => {} },
        }),
      } as never,
    });
  }

  it('미저장 충돌 편집이 있으면 바로 닫지 않고 확인을 받는다', async () => {
    const closeRepo = vi.fn(async () => {});
    const { store } = await setup({ closeRepo });
    withDraft(store, 5);
    await store.getState().requestCloseSession(5);
    expect(store.getState().sessions[5]).toBeDefined();
    expect(store.getState().closeConfirm).toEqual({ id: 5, name: 'r', paths: ['a.txt'] });
    store.getState().cancelCloseSession();
    expect(store.getState().closeConfirm).toBeNull();
    expect(store.getState().sessions[5]).toBeDefined();
    await store.getState().requestCloseSession(5);
    await store.getState().confirmCloseSession();
    expect(store.getState().sessions[5]).toBeUndefined();
    expect(closeRepo).toHaveBeenCalledWith(5);
  });

  it('초안이 없으면 바로 닫는다', async () => {
    const { store } = await setup();
    store.setState({
      sessions: { 6: { id: 6, kind: 'repo', path: '/r', name: 'r', parent: null } },
      sessionOrder: [6],
      activeSessionId: 6,
    });
    await store.getState().requestCloseSession(6);
    expect(store.getState().closeConfirm).toBeNull();
    expect(store.getState().sessions[6]).toBeUndefined();
  });
});

describe('외부 앱 열기', () => {
  it('같은 대상을 여는 동안 다시 부르면 코어를 또 부르지 않는다', async () => {
    let finish: () => void = () => {};
    const openExternal = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { store } = await setup({ openExternal });
    const first = store.getState().openExternal('editor', '/a');
    expect(store.getState().openingExternal).toEqual([externalKey('editor', '/a')]);
    expect(await store.getState().openExternal('editor', '/a')).toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toBe(true);
    expect(store.getState().openingExternal).toEqual([]);
  });

  it('다른 대상은 막지 않는다', async () => {
    const openExternal = vi.fn(async () => {});
    const { store } = await setup({ openExternal });
    await Promise.all([
      store.getState().openExternal('editor', '/a'),
      store.getState().openExternal('editor', '/b'),
      store.getState().openExternal('reveal', '/a'),
    ]);
    expect(openExternal).toHaveBeenCalledTimes(3);
  });

  it('실패하면 false 와 오류를 남기고 다시 시도할 수 있다', async () => {
    let fail = true;
    const openExternal = vi.fn(async () => {
      if (fail) {
        throw { kind: 'internal', message: '실행할 앱이 없습니다' };
      }
    });
    const { store } = await setup({ openExternal });
    expect(await store.getState().openExternal('editor', '/a')).toBe(false);
    expect(store.getState().lastError).toContain('실행할 앱이 없습니다');
    expect(store.getState().openingExternal).toEqual([]);
    fail = false;
    expect(await store.getState().openExternal('editor', '/a')).toBe(true);
    expect(store.getState().lastError).toBeNull();
  });
});
