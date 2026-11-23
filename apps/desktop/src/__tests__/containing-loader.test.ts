import { type ContainingRefs, IpcClientError } from '@mgit/ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTAINING_DEBOUNCE_MS,
  type ContainingEntry,
  createContainingLoader,
} from '../store/containing-loader';

/** 결과 하나 (브랜치 이름만) */
function refs(...names: string[]): ContainingRefs {
  return {
    timedOut: false,
    head: true,
    branches: names.map((name) => ({
      name: `refs/heads/${name}`,
      shortName: name,
      remote: false,
      current: false,
    })),
  };
}

/** 미뤄 둔 응답 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 문자열 키 지연 읽기와 그 기록 */
function setup(fetch: (key: string) => Promise<ContainingRefs> = async (k) => refs(k)) {
  const published: (ContainingEntry<string> | null)[] = [];
  const spy = vi.fn(fetch);
  const loader = createContainingLoader<string>({
    keyOf: (k) => k,
    fetch: spy,
    publish: (entry) => published.push(entry),
    describeError: (e) => (e instanceof Error ? e.message : String(e)),
  });
  const last = () => published[published.length - 1] ?? null;
  return { loader, fetch: spy, published, last };
}

/** 타이머를 옮기고 응답까지 비운다 */
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/**
 * 코어 흉내 (W18 ① 세션마다 마지막 요청만 살리기, `inspect.rs` 의 `LatestRequests`): 새 요청이 오면 아직 답하지 않은 앞
 * 요청을 `cancelled` 오류로 끝낸다. 요청마다 `ms` 뒤에 그 커밋의 결과로 답한다
 */
function latestOnlyCore(ms: number) {
  let cancelPrevious: (() => void) | null = null;
  return (key: string) =>
    new Promise<ContainingRefs>((resolve, reject) => {
      cancelPrevious?.();
      let settled = false;
      cancelPrevious = () => {
        if (!settled) {
          settled = true;
          reject(new IpcClientError({ kind: 'cancelled' }));
        }
      };
      setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(refs(key));
        }
      }, ms);
    });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('포함 branch 지연 읽기 (CD-03)', () => {
  it('보이자마자 "읽는 중" 을 싣고, 디바운스 뒤에 묻고, 답을 그 커밋 것으로 싣는다', async () => {
    const { loader, fetch, last } = setup();
    loader.show('a');
    expect(last()).toEqual({ of: 'a', state: 'loading' });
    await advance(CONTAINING_DEBOUNCE_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    await advance(1);
    expect(fetch).toHaveBeenCalledWith('a');
    expect(last()).toEqual({ of: 'a', state: 'ready', refs: refs('a') });
  });

  it('빠르게 훑는 동안은 묻지 않고, 멈춘 마지막 커밋만 한 번 묻는다', async () => {
    const { loader, fetch, last } = setup();
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      loader.show(key);
      await advance(CONTAINING_DEBOUNCE_MS / 2);
    }
    expect(fetch).not.toHaveBeenCalled();
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(fetch.mock.calls).toEqual([['e']]);
    expect(last()).toMatchObject({ of: 'e', state: 'ready' });
  });

  it('앞 요청이 코어에서 cancelled 로 끝나도 오류를 싣지 않는다: 커밋을 빠르게 옮기면 마지막 커밋의 결과만 싣는다 (W18 ①)', async () => {
    const { loader, fetch, published, last } = setup(latestOnlyCore(1_000));
    // 디바운스보다 조금 길게 멈추며 옮긴다: 요청이 겹쳐 앞 요청이 코어에서 취소된다
    for (const key of ['a', 'b', 'c']) {
      loader.show(key);
      await advance(CONTAINING_DEBOUNCE_MS + 50);
    }
    expect(fetch.mock.calls).toEqual([['a'], ['b'], ['c']]);
    expect(last()).toEqual({ of: 'c', state: 'loading' });
    await advance(1_000);
    expect(published.some((entry) => entry?.state === 'error')).toBe(false);
    expect(published.filter((entry) => entry?.state === 'ready')).toEqual([
      { of: 'c', state: 'ready', refs: refs('c') },
    ]);
    expect(last()).toEqual({ of: 'c', state: 'ready', refs: refs('c') });
  });

  it('"다시 시도" 로 같은 커밋을 다시 물어 앞 요청이 취소돼도 오류를 싣지 않는다', async () => {
    const { loader, fetch, published, last } = setup(latestOnlyCore(1_000));
    loader.show('a');
    await advance(CONTAINING_DEBOUNCE_MS + 100);
    loader.retry();
    await advance(1_000);
    expect(fetch.mock.calls).toEqual([['a'], ['a']]);
    expect(published.some((entry) => entry?.state === 'error')).toBe(false);
    expect(last()).toEqual({ of: 'a', state: 'ready', refs: refs('a') });
  });

  it('늦게 온 옛 응답은 버린다 (최신 요청의 응답만 싣는다)', async () => {
    const slow = deferred<ContainingRefs>();
    const { loader, published, last } = setup(async (k) => (k === 'a' ? slow.promise : refs(k)));
    loader.show('a');
    await advance(CONTAINING_DEBOUNCE_MS);
    loader.show('b');
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(last()).toMatchObject({ of: 'b', state: 'ready' });
    const before = published.length;
    slow.resolve(refs('a'));
    await advance(0);
    expect(published.length).toBe(before);
    expect(last()).toMatchObject({ of: 'b', state: 'ready' });
  });

  it('같은 커밋은 다시 묻지 않는다: 같은 커밋을 또 보여도, 다른 커밋을 들렀다 돌아와도 기억한 결과를 쓴다', async () => {
    const { loader, fetch, last } = setup();
    loader.show('a');
    await advance(CONTAINING_DEBOUNCE_MS);
    loader.show('a');
    await advance(CONTAINING_DEBOUNCE_MS);
    loader.show('b');
    await advance(CONTAINING_DEBOUNCE_MS);
    loader.show('a');
    expect(last()).toEqual({ of: 'a', state: 'ready', refs: refs('a') });
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(fetch.mock.calls).toEqual([['a'], ['b']]);
  });

  it('보이는 커밋이 없어지면 예약한 요청을 거두고, 이미 보낸 요청의 응답도 버린다', async () => {
    const pending = deferred<ContainingRefs>();
    const { loader, fetch, last } = setup(async (k) => (k === 'b' ? pending.promise : refs(k)));
    loader.show('a');
    loader.show(null);
    expect(last()).toBeNull();
    await advance(CONTAINING_DEBOUNCE_MS * 2);
    expect(fetch).not.toHaveBeenCalled();
    loader.show('b');
    await advance(CONTAINING_DEBOUNCE_MS);
    loader.show(null);
    pending.resolve(refs('b'));
    await advance(0);
    expect(last()).toBeNull();
  });

  it('시간 초과는 기억하지 않고 그대로 둔다. "다시 시도" 는 디바운스 없이 바로 다시 묻는다', async () => {
    let timedOut = true;
    const { loader, fetch, last } = setup(async (k) =>
      timedOut ? { timedOut: true, head: false, branches: [] } : refs(k),
    );
    loader.show('a');
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(last()).toEqual({ of: 'a', state: 'timedOut' });
    // 같은 커밋을 다시 보여도 저절로 다시 묻지 않는다 (시간 초과는 비싸다)
    loader.show('a');
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(fetch).toHaveBeenCalledTimes(1);
    timedOut = false;
    loader.retry();
    expect(last()).toEqual({ of: 'a', state: 'loading' });
    await advance(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(last()).toEqual({ of: 'a', state: 'ready', refs: refs('a') });
  });

  it('오류는 사유와 함께 싣고, 다시 시도하면 다시 묻는다', async () => {
    let fail = true;
    const { loader, last } = setup(async (k) => {
      if (fail) {
        throw new Error('no such commit');
      }
      return refs(k);
    });
    loader.show('a');
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(last()).toEqual({ of: 'a', state: 'error', error: 'no such commit' });
    fail = false;
    loader.retry();
    await advance(0);
    expect(last()).toMatchObject({ of: 'a', state: 'ready' });
  });

  it('무효화: 맞는 것만 잊고, 보이는 커밋이 거기 들면 디바운스 뒤 그것만 다시 묻는다 (몰려 와도 한 번)', async () => {
    const { loader, fetch, last } = setup();
    for (const key of ['r1:a', 'r2:b', 'r1:c']) {
      loader.show(key);
      await advance(CONTAINING_DEBOUNCE_MS);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    // 보이는 커밋(r1:c)의 저장소가 바뀌었다 — 이벤트가 셋 몰려 온다
    for (let i = 0; i < 3; i += 1) {
      loader.invalidate((k) => k.startsWith('r1:'));
    }
    expect(last()).toEqual({ of: 'r1:c', state: 'loading' });
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(fetch.mock.calls.slice(3)).toEqual([['r1:c']]);
    // 다른 저장소의 결과는 남고, 같은 저장소의 다른 커밋은 잊혔다
    loader.show('r2:b');
    await advance(CONTAINING_DEBOUNCE_MS);
    loader.show('r1:a');
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(fetch.mock.calls.slice(4)).toEqual([['r1:a']]);
    // 보이는 커밋과 무관한 무효화는 다시 묻지 않는다
    loader.invalidate((k) => k.startsWith('r2:'));
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(fetch).toHaveBeenCalledTimes(5);
    // 보이는 커밋이 없으면 무효화해도 묻지 않는다
    loader.show(null);
    loader.invalidate();
    await advance(CONTAINING_DEBOUNCE_MS);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('dispose 뒤에는 예약한 요청도 응답도 싣지 않는다', async () => {
    const { loader, fetch, published } = setup();
    loader.show('a');
    const before = published.length;
    loader.dispose();
    await advance(CONTAINING_DEBOUNCE_MS);
    loader.show('b');
    loader.retry();
    expect(fetch).not.toHaveBeenCalled();
    expect(published.length).toBe(before);
  });
});
