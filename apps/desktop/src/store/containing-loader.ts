// 커밋을 포함하는 브랜치 줄 (CD-03) 의 지연 읽기. 폴더 스토어와 세션 스토어가 함께 쓴다 — 두 스토어는
// "무엇으로 묻는지(fetch)"와 "어디에 싣는지(publish)"만 다르고, 언제 묻고 무엇을 버리는지는 같다.
//
// - 화면이 지금 보이는 커밋을 `show` 로 알린다. 짧은 디바운스 뒤에 묻는다 — 로그를 ↑↓ 로 빠르게 훑는 동안은
//   묻지 않는다.
// - 차례(seq)로 최신 요청의 응답만 반영하고 늦게 온 옛 응답은 버린다.
// - 읽은 결과는 커밋별로 기억해 같은 커밋을 다시 보여도 묻지 않는다. ref 가 바뀌면 `invalidate` 로 지우고,
//   지금 보이는 커밋만 다시 묻는다.
// - 시간 초과·오류는 기억하지 않는다 ("다시 시도" = `retry`).

import type { ContainingRefs } from '@mgit/ipc';

/** 선택이 바뀐 뒤 묻기까지 기다리는 시간 (ms) */
export const CONTAINING_DEBOUNCE_MS = 200;
/** 기억해 두는 커밋 수 상한 (오래된 것부터 버린다) */
const CACHE_LIMIT = 64;

/** 포함 브랜치 줄의 상태 */
export type ContainingLoad =
  | { state: 'loading' }
  | { state: 'ready'; refs: ContainingRefs }
  | { state: 'timedOut' }
  | { state: 'error'; error: string };

/** 어느 커밋의 상태인지 붙인 것. 화면은 `of` 가 지금 보이는 커밋일 때만 쓴다 */
export type ContainingEntry<K> = ContainingLoad & { of: K };

export interface ContainingLoaderOptions<K> {
  /** 같은 커밋인지 가리는 문자열 키 */
  keyOf(key: K): string;
  /** 실제 요청 */
  fetch(key: K): Promise<ContainingRefs>;
  /** 상태가 바뀔 때 스토어에 싣는다. 보이는 커밋이 없으면 null */
  publish(entry: ContainingEntry<K> | null): void;
  /** 오류를 화면 문구로 */
  describeError(error: unknown): string;
  /** 디바운스 (ms). 주지 않으면 `CONTAINING_DEBOUNCE_MS` */
  debounceMs?: number;
}

export interface ContainingLoader<K> {
  /**
   * 지금 보이는 커밋을 알린다 (null = 없음). 같은 커밋이면 아무것도 하지 않고(시간 초과·오류도 그대로 둔다),
   * 기억해 둔 결과가 있으면 묻지 않고 바로 싣고, 없으면 "읽는 중" 을 싣고 디바운스 뒤에 묻는다
   */
  show(key: K | null): void;
  /** 지금 보이는 커밋을 디바운스 없이 다시 묻는다 ("다시 시도") */
  retry(): void;
  /**
   * 기억해 둔 결과를 지운다 (`match` 가 없으면 전부). 지금 보이는 커밋이 지운 대상이면 디바운스 뒤에 다시 묻는다
   * (ref 변경이 몰려 와도 한 번만 묻는다)
   */
  invalidate(match?: (key: K) => boolean): void;
  /** 타이머를 멈추고 이후 응답을 모두 버린다 */
  dispose(): void;
}

/** 지연 읽기 하나를 만든다 */
export function createContainingLoader<K>(opts: ContainingLoaderOptions<K>): ContainingLoader<K> {
  const debounceMs = opts.debounceMs ?? CONTAINING_DEBOUNCE_MS;
  const cache = new Map<string, { key: K; refs: ContainingRefs }>();
  let current: K | null = null;
  let shown: ContainingLoad['state'] | null = null;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  /** 예약한 요청을 거둔다 */
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 지금 커밋의 상태를 싣는다 */
  const publish = (load: ContainingLoad | null) => {
    shown = load?.state ?? null;
    opts.publish(load !== null && current !== null ? { ...load, of: current } : null);
  };

  /** 결과를 기억한다. 상한을 넘으면 가장 오래된 것을 버린다 */
  const remember = (key: K, refs: ContainingRefs) => {
    const id = opts.keyOf(key);
    cache.delete(id);
    cache.set(id, { key, refs });
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
  };

  /** 바로 묻는다. 그사이 차례가 지났으면(다른 커밋을 보이거나 다시 물었으면) 응답을 버린다 */
  const request = async (key: K) => {
    const turn = ++seq;
    try {
      const refs = await opts.fetch(key);
      if (turn !== seq || disposed) {
        return;
      }
      if (refs.timedOut) {
        publish({ state: 'timedOut' });
        return;
      }
      remember(key, refs);
      publish({ state: 'ready', refs });
    } catch (error) {
      if (turn !== seq || disposed) {
        return;
      }
      publish({ state: 'error', error: opts.describeError(error) });
    }
  };

  /** "읽는 중" 을 싣고 디바운스 뒤에 묻는다. 도는 요청의 응답은 버린다 */
  const schedule = (key: K) => {
    clearTimer();
    seq += 1;
    publish({ state: 'loading' });
    timer = setTimeout(() => {
      timer = null;
      void request(key);
    }, debounceMs);
  };

  return {
    show(key) {
      if (disposed) {
        return;
      }
      if (key === null) {
        clearTimer();
        seq += 1;
        current = null;
        publish(null);
        return;
      }
      if (current !== null && shown !== null && opts.keyOf(current) === opts.keyOf(key)) {
        return;
      }
      current = key;
      const hit = cache.get(opts.keyOf(key));
      if (hit) {
        clearTimer();
        seq += 1;
        publish({ state: 'ready', refs: hit.refs });
        return;
      }
      schedule(key);
    },

    retry() {
      if (disposed || current === null) {
        return;
      }
      clearTimer();
      publish({ state: 'loading' });
      void request(current);
    },

    invalidate(match) {
      for (const [id, entry] of [...cache]) {
        if (!match || match(entry.key)) {
          cache.delete(id);
        }
      }
      if (!disposed && current !== null && shown !== null && (!match || match(current))) {
        schedule(current);
      }
    },

    dispose() {
      disposed = true;
      clearTimer();
      seq += 1;
    },
  };
}
