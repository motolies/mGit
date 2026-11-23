// A6: 세션 스토어의 tag 쓰기 (`pushTags`·`deleteTagsScoped`, TG-01·02·05·07) — 결과 알림의 갈래, 결과를 스스로 알리는
// op 의 끝 토스트 거르기, 확인창 동안 busy 유지, branch push 의 서버 거부 문구

import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RefLabel,
  type RepoOpened,
  type TagRefResult,
  type TagSyncReport,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyHub } from '../store/notify';
import { createSessionStore, type SessionState } from '../store/session-store';

const HEAD = 'a'.repeat(40);
const TAG_COMMIT = 'd'.repeat(40);
const R_OID = 'f'.repeat(40);

type Store = ReturnType<typeof createSessionStore>;

/** 스토어와 클라이언트. `over` 는 스토어를 받아 메서드를 만든다 (이벤트를 호출 도중에 넣으려고) */
function setup(over: (store: () => Store) => Partial<IpcClient> = () => ({})) {
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
  let store: Store | null = null;
  const get = () => store as Store;
  const client = { ...createNullClient(), ...over(get) } as IpcClient;
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  store = createSessionStore(opened, client, cache);
  const tag: RefLabel = {
    fullName: 'refs/tags/v1',
    shortName: 'v1',
    kind: { kind: 'tag', annotated: true },
    target: TAG_COMMIT,
    isCurrent: false,
    upstreamGone: false,
  };
  store.setState({ refs: { ...store.getState().refs, labels: [tag] } } as Partial<SessionState>);
  return { store, client };
}

/** 결과 한 줄 */
const res = (name: string, status: TagRefResult['status'], extra: Partial<TagRefResult> = {}) => ({
  name,
  status,
  message: null,
  remoteOid: null,
  remoteCommit: null,
  ...extra,
});

/** op 시작·끝 이벤트 */
const started = (store: Store, opId: number, kind = 'push') =>
  store.getState().applyEvent({
    type: 'operationStarted',
    session: 1,
    opId,
    kind,
    label: `push origin v${opId}`,
  });
const finished = (store: Store, opId: number, ok: boolean) =>
  store.getState().applyEvent({
    type: 'operationFinished',
    session: 1,
    opId,
    ok,
    cancelled: false,
    message: ok ? '' : 'tag 1개 중 1개가 처리되지 않았습니다',
    lockLeft: false,
  });

const notices: { kind: string; title: string }[] = [];
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  notices.length = 0;
  notifyHub.setHandler((n) => notices.push({ kind: n.kind, title: n.title }));
});
afterEach(() => {
  notifyHub.setHandler(null);
});

describe('pushTags 결과 알림 (TG-01 ⑧, TG-02)', () => {
  it('하나를 올리면 성공 토스트, 이미 같으면 안내 토스트. 결과를 돌려주고 busy 를 푼다', async () => {
    const pushTags = vi.fn(async (_s: number, _r: string, names: string[]) =>
      names.map((n) => res(n, n === 'v1' ? 'pushed' : 'upToDate')),
    );
    const { store } = setup(() => ({ pushTags }));
    expect(await store.getState().pushTags('origin', ['v1'])).toEqual([res('v1', 'pushed')]);
    await store.getState().pushTags('origin', ['v0']);
    expect(notices).toEqual([
      { kind: 'success', title: S.tag.pushed('v1', 'origin') },
      { kind: 'info', title: S.tag.upToDate('v0', 'origin') },
    ]);
    expect(pushTags).toHaveBeenCalledWith(1, 'origin', ['v1']);
    expect(store.getState().busy).toBe(false);
  });

  it('이름 충돌은 안내 힌트(tagExists)이고 NFF·오류 줄·토스트는 없다. 서버 거부는 사유를 오류 줄에', async () => {
    const { store } = setup(() => ({
      pushTags: async (_s, _r, names) =>
        names.map((n) =>
          n === 'v2.3.1'
            ? res(n, 'rejectedExists', { message: 'already exists' })
            : res(n, 'rejectedRemote', { message: 'pre-receive hook declined' }),
        ),
    }));
    await store.getState().pushTags('origin', ['v2.3.1']);
    expect(store.getState().pendingHint).toMatchObject({
      kind: 'tagExists',
      remote: 'origin',
      names: ['v2.3.1'],
    });
    expect(store.getState().actionError).toBeNull();
    store.getState().dismissHint();
    await store.getState().pushTags('origin', ['v1']);
    expect(store.getState().pendingHint).toBeNull();
    expect(store.getState().actionError).toBe(
      S.tag.pushFailed('origin', `v1 (${S.error.remoteRejected('pre-receive hook declined')})`),
    );
    expect(notices).toEqual([]);
  });

  it('명령 전체가 실패하면(인증) undefined 이고 오류 줄', async () => {
    const { store } = setup(() => ({
      pushTags: async () => {
        throw {
          kind: 'gitFailed',
          args: ['push'],
          status: 128,
          stderr: 'fatal: Authentication failed',
          hint: { kind: 'authFailed' },
        };
      },
    }));
    expect(await store.getState().pushTags('origin', ['v1'])).toBeUndefined();
    expect(store.getState().actionError).toBe(
      S.error.gitFailed(['push'], 'fatal: Authentication failed'),
    );
  });
});

describe('결과를 스스로 알리는 op 의 끝 토스트 (H1 계약)', () => {
  it('tag 작업 중 시작한 push op 의 실패 토스트는 끝 이벤트가 응답보다 늦게 와도 띄우지 않는다. 다른 push op 는 그대로', async () => {
    const { store } = setup((get) => ({
      pushTags: async (_s, _r, names) => {
        started(get(), 7);
        return names.map((n) => res(n, 'rejectedRemote', { message: 'hook' }));
      },
    }));
    await store.getState().pushTags('origin', ['v1']);
    // 응답 뒤에 끝 이벤트가 온다
    finished(store, 7, false);
    expect(notices).toEqual([]);
    // tag 작업 밖의 push op(branch push 등) 실패는 지금처럼 알린다
    started(store, 8);
    finished(store, 8, false);
    expect(notices.map((n) => n.kind)).toEqual(['error']);
  });
});

describe('deleteTagsScoped (TG-03~05)', () => {
  it('원격이 다르면 묻는 동안에도 busy 가 켜져 있고, busy 는 한 번만 켜진다. 다 지우면 토스트', async () => {
    let calls = 0;
    const deleteLocalTags = vi.fn(async () => {});
    const { store } = setup(() => ({
      deleteRemoteTags: async (_s, _r, items) => {
        calls += 1;
        return items.map((i) =>
          calls === 1 && i.name === 'v1'
            ? res(i.name, 'diverged', { remoteOid: R_OID, remoteCommit: 'e'.repeat(40) })
            : res(i.name, 'deleted'),
        );
      },
      deleteLocalTags,
    }));
    const busyTurns: boolean[] = [];
    store.subscribe((st, prev) => {
      if (st.busy !== prev.busy) {
        busyTurns.push(st.busy);
      }
    });
    const onDiverged = vi.fn(async (items: { localCommit: string | null }[]) => {
      expect(store.getState().busy).toBe(true);
      expect(items[0]?.localCommit).toBe(TAG_COMMIT);
      return 'all' as const;
    });
    const summary = await store
      .getState()
      .deleteTagsScoped(['v1'], { local: true, remotes: ['origin'] }, { onDiverged });
    expect(onDiverged).toHaveBeenCalledTimes(1);
    expect(busyTurns).toEqual([true, false]);
    expect(deleteLocalTags).toHaveBeenCalledWith(1, ['v1']);
    expect(summary?.localDeleted).toEqual(['v1']);
    expect(notices).toEqual([
      { kind: 'success', title: S.tag.del.done('v1', `${S.tag.del.local} · origin`) },
    ]);
  });

  it('원격이 거부하면 로컬은 남기고 오류 줄로 알린다. 취소해서 바뀐 것이 없으면 아무것도 알리지 않는다', async () => {
    const deleteLocalTags = vi.fn(async () => {});
    const { store } = setup(() => ({
      deleteRemoteTags: async (_s, _r, items) =>
        items.map((i) =>
          i.name === 'v1'
            ? res(i.name, 'rejectedRemote', { message: 'protected tag' })
            : res(i.name, 'diverged', { remoteOid: R_OID }),
        ),
      deleteLocalTags,
    }));
    await store.getState().deleteTagsScoped(['v1'], { local: true, remotes: ['origin'] });
    expect(deleteLocalTags).not.toHaveBeenCalled();
    expect(store.getState().actionError).toBe(
      [
        S.tag.del.remoteFailed('origin', `v1 (${S.error.remoteRejected('protected tag')})`),
        S.tag.del.localKept('v1'),
      ].join(' · '),
    );
    store.getState().clearActionError();
    await store.getState().deleteTagsScoped(
      ['v2'],
      { local: true, remotes: ['origin'] },
      {
        onDiverged: async () => 'cancel',
      },
    );
    expect(store.getState().actionError).toBeNull();
    expect(notices).toEqual([]);
  });

  it('지울 곳이 비었으면 아무것도 하지 않는다', async () => {
    const deleteRemoteTags = vi.fn(async () => []);
    const { store } = setup(() => ({ deleteRemoteTags }));
    expect(
      await store.getState().deleteTagsScoped(['v1'], { local: false, remotes: [] }),
    ).toBeUndefined();
    expect(deleteRemoteTags).not.toHaveBeenCalled();
    expect(store.getState().busy).toBe(false);
  });
});

describe('branch push 의 서버 거부 (TG-07, A1 이후)', () => {
  it('remoteRejected 는 강제 push 대화상자 없이 오류 줄에 서버 사유', async () => {
    const { store } = setup(() => ({
      push: async () => {
        throw {
          kind: 'gitFailed',
          args: ['push', 'origin', 'main'],
          status: 1,
          stderr: ' ! [remote rejected] main -> main (pre-receive hook declined)',
          hint: { kind: 'remoteRejected', reason: 'pre-receive hook declined' },
        };
      },
    }));
    expect(await store.getState().push({ remote: 'origin' })).toBe(false);
    await tick();
    expect(store.getState().pendingHint).toBeNull();
    expect(store.getState().actionError).toBe(S.error.remoteRejected('pre-receive hook declined'));
  });
});

/** 원격 tag 보고서 하나 (확인함, 빈 항목) */
const report = (remote: string, over: Partial<TagSyncReport> = {}): TagSyncReport => ({
  remote,
  checkedAt: 1_000,
  stale: false,
  lastError: null,
  counts: { localOnly: 0, remoteOnly: 0, same: 0, diverged: 0, unknown: 0 },
  entries: [],
  pushUrlDiffers: false,
  ...over,
});

/** 세션 ref 에 원격을 둔다 */
const withRemotes = (store: Store, names: string[]) =>
  store.setState({
    refs: {
      ...store.getState().refs,
      remotes: names.map((name) => ({ name, fetchUrl: `https://x/${name}`, pushUrl: null })),
    },
  } as Partial<SessionState>);

/** 밖에서 푸는 약속 */
function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('원격 tag 확인 (B5, TG-08·09)', () => {
  it('busy 를 켜지 않고 원격마다 받는다. 확인 op(tagCheck)의 실패·오래 걸림 토스트는 없다. 실패는 그 원격의 lastError 로 남는다', async () => {
    const { store } = setup((get) => ({
      remoteTags: async (_s, remote, refresh) => {
        expect(refresh).toBe(true);
        expect(get().getState().tagChecking).toEqual(['origin', 'upstream']);
        started(get(), remote === 'origin' ? 31 : 32, 'tagCheck');
        finished(get(), remote === 'origin' ? 31 : 32, remote === 'origin');
        return remote === 'origin'
          ? report('origin')
          : report('upstream', {
              checkedAt: null,
              lastError: { kind: 'network', at: 2_000, message: 'Could not resolve host' },
            });
      },
    }));
    withRemotes(store, ['origin', 'upstream']);
    const busy: boolean[] = [];
    store.subscribe((st, prev) => {
      if (st.busy !== prev.busy) {
        busy.push(st.busy);
      }
    });
    await store.getState().checkRemoteTags();
    expect(busy).toEqual([]);
    expect(store.getState().tagChecking).toEqual([]);
    expect(Object.keys(store.getState().tagReports).sort()).toEqual(['origin', 'upstream']);
    expect(store.getState().tagReports.upstream?.lastError?.kind).toBe('network');
    expect(notices).toEqual([]);
    expect(store.getState().actionError).toBeNull();
  });

  it('한 원격이 거부돼도 다른 원격의 결과는 남는다. 취소는 조용히, 원격 문제는 오류 줄', async () => {
    let round = 0;
    const { store } = setup(() => ({
      remoteTags: async (_s, remote) => {
        if (round === 1 && remote === 'upstream') {
          throw { kind: 'cancelled' };
        }
        if (round === 2 && remote === 'upstream') {
          throw { kind: 'internal', message: '원격이 없습니다: upstream' };
        }
        return report(remote ?? '', { checkedAt: 1_000 + round });
      },
    }));
    withRemotes(store, ['origin', 'upstream']);
    await store.getState().checkRemoteTags();
    round = 1;
    await store.getState().checkRemoteTags();
    expect(store.getState().tagReports.origin?.checkedAt).toBe(1_001);
    expect(store.getState().tagReports.upstream?.checkedAt).toBe(1_000);
    expect(store.getState().actionError).toBeNull();
    round = 2;
    await store.getState().checkRemoteTags(['upstream']);
    expect(store.getState().actionError).toBe('원격이 없습니다: upstream');
    expect(store.getState().tagReports.origin?.checkedAt).toBe(1_001);
  });

  it('push 뒤에는 네트워크 없이(refresh=false) 받은 원격만 다시 받는다 (TG-09 ⑤)', async () => {
    const remoteTags = vi.fn(async (_s: number, remote: string | null, _refresh: boolean) =>
      report(remote ?? ''),
    );
    const { store } = setup(() => ({
      remoteTags,
      pushTags: async (_s, _r, names) => names.map((n) => res(n, 'pushed')),
    }));
    withRemotes(store, ['origin', 'upstream']);
    await store.getState().checkRemoteTags(['origin']);
    remoteTags.mockClear();
    await store.getState().pushTags('origin', ['v1']);
    await tick();
    expect(remoteTags.mock.calls).toEqual([[1, 'origin', false]]);
  });

  it('늦게 끝난 옛 다시 받기가 그 뒤에 끝난 확인을 덮지 않는다', async () => {
    const slow = deferred<TagSyncReport>();
    const { store } = setup(() => ({
      remoteTags: async (_s, remote, refresh) =>
        refresh ? report(remote ?? '', { checkedAt: 9_000 }) : slow.promise,
    }));
    withRemotes(store, ['origin']);
    store.setState({ tagReports: { origin: report('origin') } } as Partial<SessionState>);
    const reload = store.getState().reloadRemoteTags();
    await store.getState().checkRemoteTags(['origin']);
    slow.resolve(report('origin', { checkedAt: 1_000 }));
    await reload;
    expect(store.getState().tagReports.origin?.checkedAt).toBe(9_000);
  });

  it('다시 받기: 사라진 원격과 비워진 캐시의 보고서는 지우고, all 이면 모든 원격을 읽는다', async () => {
    const { store } = setup(() => ({
      remoteTags: async (_s, remote) =>
        remote === 'origin' ? report('origin', { checkedAt: null }) : report(remote ?? ''),
    }));
    withRemotes(store, ['origin', 'upstream']);
    store.setState({
      tagReports: { origin: report('origin'), gone: report('gone') },
    } as Partial<SessionState>);
    await store.getState().reloadRemoteTags();
    expect(Object.keys(store.getState().tagReports)).toEqual([]);
    await store.getState().reloadRemoteTags({ all: true });
    expect(Object.keys(store.getState().tagReports)).toEqual(['upstream']);
  });

  it('다시 받기가 같은 값의 보고서를 주면 상태를 바꾸지 않는다 (트리를 다시 그리지 않게). 바뀌면 바꾼다', async () => {
    const next: Record<string, TagSyncReport> = {
      origin: report('origin'),
      upstream: report('upstream'),
    };
    // 매번 새 객체 (코어가 IPC 로 보내는 것처럼)
    const { store } = setup(() => ({
      remoteTags: async (_s, remote) => structuredClone(next[remote ?? ''] as TagSyncReport),
    }));
    withRemotes(store, ['origin', 'upstream']);
    await store.getState().reloadRemoteTags({ all: true });
    const first = store.getState().tagReports;
    expect(Object.keys(first)).toEqual(['origin', 'upstream']);
    // 새로 받은 같은 값 → 참조 그대로
    await store.getState().reloadRemoteTags({ all: true });
    expect(store.getState().tagReports).toBe(first);
    // 값이 바뀌면 바꾼다 (다른 원격의 보고서 참조는 그대로)
    next.origin = report('origin', { stale: true });
    await store.getState().reloadRemoteTags({ all: true });
    expect(store.getState().tagReports).not.toBe(first);
    expect(store.getState().tagReports.origin?.stale).toBe(true);
    expect(store.getState().tagReports.upstream).toBe(first.upstream);
  });

  it('확인한 적 없는 원격의 빈 보고서는 상태를 바꾸지 않는다 (지울 것이 없다)', async () => {
    const { store } = setup(() => ({
      remoteTags: async (_s, remote) => report(remote ?? '', { checkedAt: null }),
    }));
    withRemotes(store, ['origin']);
    const before = store.getState().tagReports;
    await store.getState().reloadRemoteTags({ all: true });
    expect(store.getState().tagReports).toBe(before);
  });

  it('ref 가 바뀌면 받은 보고서가 있을 때만 잠시 뒤 한 번 다시 받는다', async () => {
    const remoteTags = vi.fn(async (_s: number, remote: string | null) => report(remote ?? ''));
    const { store } = setup(() => ({ remoteTags }));
    withRemotes(store, ['origin']);
    const refs = store.getState().refs;
    store.getState().applyEvent({ type: 'refsChanged', session: 1, refs });
    await new Promise((r) => setTimeout(r, 350));
    expect(remoteTags).not.toHaveBeenCalled();
    store.setState({ tagReports: { origin: report('origin') } } as Partial<SessionState>);
    store.getState().applyEvent({ type: 'refsChanged', session: 1, refs });
    store.getState().applyEvent({ type: 'refsChanged', session: 1, refs });
    await new Promise((r) => setTimeout(r, 350));
    expect(remoteTags.mock.calls).toEqual([[1, 'origin', false]]);
  });

  it('이름 충돌 안내에 단일 조회로 받은 두 commit 을 채운다 (TG-02 B)', async () => {
    const lookupRemoteTags = vi.fn(async () => [
      { name: 'v1', object: R_OID, peeled: 'e'.repeat(40) },
    ]);
    const { store } = setup(() => ({
      pushTags: async (_s, _r, names) => names.map((n) => res(n, 'rejectedExists')),
      lookupRemoteTags,
    }));
    await store.getState().pushTags('origin', ['v1']);
    await tick();
    expect(lookupRemoteTags).toHaveBeenCalledWith(1, 'origin', ['v1']);
    expect(store.getState().pendingHint).toEqual({
      kind: 'tagExists',
      remote: 'origin',
      names: ['v1'],
      commits: [{ name: 'v1', local: TAG_COMMIT, remote: 'e'.repeat(40), remoteObject: R_OID }],
    });
  });
});

describe('가져오기·로컬 tag 목록 (C3b, TG-11)', () => {
  it('하나를 가져오면 토스트(덮어쓰기면 바꿨다고), 실패는 오류 줄. 가져오기 op 의 실패 토스트는 없다', async () => {
    const fetchTags = vi.fn(async (_s: number, _r: string, names: string[], _o: boolean) => {
      started(store, 41, 'fetch');
      return names.map((n) =>
        res(
          n,
          n === 'bad' ? 'rejectedExists' : 'fetched',
          n === 'bad' ? { message: 'would clobber existing tag' } : {},
        ),
      );
    });
    const { store } = setup(() => ({ fetchTags }));
    expect(await store.getState().fetchTags('origin', ['v1'], false)).toEqual([
      res('v1', 'fetched'),
    ]);
    await store.getState().fetchTags('origin', ['v1'], true);
    expect(notices).toEqual([
      { kind: 'success', title: S.tag.fetched('v1', 'origin', false) },
      { kind: 'success', title: S.tag.fetched('v1', 'origin', true) },
    ]);
    await store.getState().fetchTags('origin', ['bad'], false);
    finished(store, 41, false);
    expect(store.getState().actionError).toBe(
      S.tag.fetchFailed('origin', `bad (${S.tag.status.rejectedExists})`),
    );
    expect(notices).toHaveLength(2);
    expect(store.getState().busy).toBe(false);
  });

  it('원격에 없는 이름이 섞여 전체가 멈추면 "원격 확인 뒤 다시 시도", 다른 실패는 그 사유', async () => {
    let stderr = "fatal: couldn't find remote ref refs/tags/v9";
    const { store } = setup(() => ({
      fetchTags: async () => {
        throw { kind: 'gitFailed', args: ['fetch'], status: 128, stderr, hint: null };
      },
    }));
    expect(await store.getState().fetchTags('origin', ['v1', 'v9'], false)).toBeUndefined();
    expect(store.getState().actionError).toBe(S.tag.fetchRecheck('origin'));
    stderr = 'fatal: unable to access';
    await store.getState().fetchTags('origin', ['v1'], false);
    expect(store.getState().actionError).toBe(
      S.error.gitFailed(['fetch'], 'fatal: unable to access'),
    );
  });

  it('로컬 tag 목록: 늦게 온 옛 응답은 새 목록을 덮지 않고, 실패하면 이전 값을 둔다', async () => {
    const slow = deferred<never[]>();
    const tag = (name: string) => ({
      name,
      annotated: false,
      object: TAG_COMMIT,
      commit: TAG_COMMIT,
      date: 1,
      commitSubject: 's',
      tagSubject: null,
      tagger: null,
    });
    let round = 0;
    const { store } = setup(() => ({
      tagList: async () => {
        round += 1;
        if (round === 1) {
          return slow.promise;
        }
        if (round === 3) {
          throw new Error('x');
        }
        return [tag('v2')];
      },
    }));
    const first = store.getState().loadTagList();
    await store.getState().loadTagList();
    slow.resolve([]);
    await first;
    expect(store.getState().tagList?.map((t) => t.name)).toEqual(['v2']);
    await store.getState().loadTagList();
    expect(store.getState().tagList?.map((t) => t.name)).toEqual(['v2']);
  });
});

describe('로컬 것으로 덮어쓰기 (C5, TG-15)', () => {
  it('lease push 한 번: 모두 성공이면 토스트, 그 사이 바뀌었으면 원격 그대로라는 사유를 오류 줄에. op 끝 토스트는 없다', async () => {
    const replaceRemoteTags = vi.fn(async (_s: number, _r: string, items: { name: string }[]) => {
      started(store, 51);
      return items.map((i) =>
        i.name === 'v1'
          ? res(i.name, 'pushed')
          : res(i.name, 'rejectedStale', {
              message: '확인한 뒤 원격 tag 가 바뀌었습니다. 다시 확인하세요',
            }),
      );
    });
    const { store } = setup(() => ({ replaceRemoteTags }));
    await store.getState().replaceRemoteTags('origin', [{ name: 'v1', expectedRemote: R_OID }]);
    expect(replaceRemoteTags).toHaveBeenCalledWith(1, 'origin', [
      { name: 'v1', expectedRemote: R_OID },
    ]);
    expect(notices).toEqual([{ kind: 'success', title: S.tag.replaced('v1', 'origin') }]);
    await store.getState().replaceRemoteTags('origin', [{ name: 'v2', expectedRemote: R_OID }]);
    finished(store, 51, false);
    expect(store.getState().actionError).toBe(
      S.tag.replaceFailed('origin', `v2 (${S.tag.status.rejectedStale})`),
    );
    expect(notices).toHaveLength(1);
  });
});
