import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { beforeEach, describe, expect, it } from 'vitest';
import { notifyHub } from '../store/notify';
import {
  createSessionStore,
  type DraftDropCause,
  draftDroppedTitle,
  type SessionState,
  type SessionStore,
} from '../store/session-store';

// W19: 저장하지 않은 충돌 편집(초안)을 버린 사유를 가른다 — 이 세션의 Continue·Skip·Abort 로 충돌이 사라진 경우와 밖에서
// 해결된 경우. 코어는 쓰기 뒤 상태를 다시 읽어 알린 다음에 응답한다 (목도 같다)

const HEAD = 'a'.repeat(40);
const draft = { text: 'mine', ranges: [], key: 'k' };

/** 스토어 하나. `over` 는 만든 스토어를 돌려주는 함수를 받아 클라이언트를 바꾼다 (명령이 도는 동안 이벤트를 보내려고) */
function setup(over: (store: () => SessionStore) => Partial<IpcClient> = () => ({})) {
  const head = { state: 'attached' as const, branch: 'main', oid: HEAD };
  const opened: RepoOpened = {
    session: 1,
    alreadyOpen: false,
    nestedRepos: [],
    superproject: null,
    info: {
      workTree: '/r',
      gitDir: '/r/.git',
      commonDir: '/r/.git',
      objectFormat: 'sha1',
      head,
      commitGraph: { present: false },
      shallow: false,
    },
    state: emptyRepoState(head),
  };
  let store: SessionStore | null = null;
  const client: IpcClient = { ...createNullClient(), ...over(() => store as SessionStore) };
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  store = createSessionStore(opened, client, cache);
  return store;
}

/** 지금 상태에서 충돌 항목만 바꾼 statusChanged */
function statusEvent(s: SessionState, paths: string[]) {
  return {
    type: 'statusChanged' as const,
    session: 1,
    status: {
      ...s.status,
      entries: paths.map((path) => ({
        path,
        index: 'unmerged',
        worktree: 'unmerged',
        conflict: true,
      })),
    } as unknown as SessionState['status'],
    op: null,
  };
}

/** 충돌이 다 사라졌다는 상태 변경을 보낸다 */
const resolvedAll = (store: SessionStore) =>
  store.getState().applyEvent(statusEvent(store.getState(), []));

const notes: { title: string }[] = [];
beforeEach(() => {
  notes.length = 0;
  notifyHub.setHandler((n) => notes.push(n));
});

describe('초안을 버린 사유의 문구 (W19)', () => {
  it.each<[DraftDropCause, string]>([
    ['external', S.conflict.externallyResolved('a.txt')],
    ['abort', S.conflict.droppedByAbort('a.txt')],
    ['skip', S.conflict.droppedBySkip('a.txt')],
    ['continue', S.conflict.droppedByContinue('a.txt')],
  ])('%s', (cause, title) => {
    expect(draftDroppedTitle('a.txt', cause)).toBe(title);
  });

  it('중단·건너뛰기 문구는 "밖에서 해결" 이라고 말하지 않는다', () => {
    expect(draftDroppedTitle('a.txt', 'abort')).not.toContain('밖에서');
    expect(draftDroppedTitle('a.txt', 'skip')).not.toContain('밖에서');
  });
});

describe('초안을 버린 사유 가르기 (W19)', () => {
  it('Abort 가 도는 동안 충돌이 사라지면 "작업을 중단해" 로 알린다', async () => {
    const store = setup((get) => ({
      opAbort: async () => resolvedAll(get()),
    }));
    store.getState().setConflictDraft('a.txt', draft);
    await store.getState().opAbort();
    expect(store.getState().conflictDrafts).toEqual({});
    expect(notes.map((n) => n.title)).toEqual([S.conflict.droppedByAbort('a.txt')]);
  });

  it('Skip 이 도는 동안이면 "커밋을 건너뛰어" 로 알린다', async () => {
    const store = setup((get) => ({
      opSkip: async () => {
        resolvedAll(get());
        return 'clean';
      },
    }));
    store.getState().setConflictDraft('a.txt', draft);
    await store.getState().opSkip();
    expect(notes.map((n) => n.title)).toEqual([S.conflict.droppedBySkip('a.txt')]);
  });

  it('응답이 상태 변경보다 먼저 닿아도(성공) 그다음 한 번은 그 명령의 것이고, 그 뒤는 밖의 것이다', async () => {
    const store = setup(() => ({ opAbort: async () => {} }));
    store.getState().setConflictDraft('a.txt', draft);
    await store.getState().opAbort();
    resolvedAll(store);
    expect(notes.map((n) => n.title)).toEqual([S.conflict.droppedByAbort('a.txt')]);
    // 다음 충돌의 초안이 밖에서 해결되면 다시 "밖에서 해결" 이다
    store.getState().applyEvent(statusEvent(store.getState(), ['b.txt']));
    store.getState().setConflictDraft('b.txt', draft);
    resolvedAll(store);
    expect(notes.map((n) => n.title).at(-1)).toBe(S.conflict.externallyResolved('b.txt'));
  });

  it('명령이 도는 동안 받은 상태 변경이 있었으면 응답 뒤의 상태 변경은 밖의 것이다', async () => {
    const store = setup((get) => ({
      opAbort: async () =>
        get()
          .getState()
          .applyEvent(statusEvent(get().getState(), ['a.txt'])),
    }));
    store.getState().setConflictDraft('a.txt', draft);
    await store.getState().opAbort();
    // 도는 동안 받은 변경에서는 a.txt 가 아직 충돌이라 초안이 남았다. 그 뒤 밖에서 해결됐다
    expect(notes).toEqual([]);
    resolvedAll(store);
    expect(notes.map((n) => n.title)).toEqual([S.conflict.externallyResolved('a.txt')]);
  });

  it('명령이 실패하면 그 뒤의 상태 변경은 밖의 것이다', async () => {
    const store = setup(() => ({
      opAbort: async () => {
        throw { kind: 'internal', message: '실패' };
      },
    }));
    store.getState().setConflictDraft('a.txt', draft);
    await store.getState().opAbort();
    expect(store.getState().actionError).not.toBeNull();
    resolvedAll(store);
    expect(notes.map((n) => n.title)).toEqual([S.conflict.externallyResolved('a.txt')]);
  });

  it('명령 없이 사라지면 지금처럼 "밖에서 해결" 이다', () => {
    const store = setup();
    store.getState().setConflictDraft('a.txt', draft);
    resolvedAll(store);
    expect(notes.map((n) => n.title)).toEqual([S.conflict.externallyResolved('a.txt')]);
  });
});
