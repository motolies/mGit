import { afterEach, describe, expect, it, vi } from 'vitest';
import { type IpcObserver, observeMethods, setIpcObserver, tapEvents } from '../observe';

/** 호출·이벤트를 그대로 모으는 관찰자 */
function collector() {
  const calls: { name: string; ok: boolean; ms: number }[] = [];
  const events: string[] = [];
  const observer: IpcObserver = {
    call: (name, start, end, ok) => calls.push({ name, ok, ms: end - start }),
    event: (source, type) => events.push(`${source}:${type}`),
  };
  return { calls, events, observer };
}

afterEach(() => setIpcObserver(null));

describe('IPC 관찰 (M1)', () => {
  it('관찰자가 없으면 원래 함수를 원래 this 로 부르고 결과를 그대로 준다', async () => {
    const target = {
      base: 2,
      double(this: { base: number }, n: number) {
        return Promise.resolve(n * this.base);
      },
      inner(this: { double(n: number): Promise<number> }) {
        return this.double(5);
      },
    };
    const spy = vi.spyOn(target, 'double');
    const wrapped = observeMethods(target);
    await expect(wrapped.double(3)).resolves.toBe(6);
    // 내부 this.x 호출은 원래 객체로 간다 (목의 내부 호출을 따로 세지 않는다)
    await expect(wrapped.inner()).resolves.toBe(10);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(wrapped.base).toBe(2);
  });

  it('관찰자가 있으면 메서드 이름·성공 여부를 알리고 내부 호출은 세지 않는다', async () => {
    const { calls, observer } = collector();
    setIpcObserver(observer);
    const target = {
      ok: async () => 'value',
      fail: async () => {
        throw new Error('rejected');
      },
      outer(this: { ok(): Promise<string> }) {
        return this.ok();
      },
    };
    const wrapped = observeMethods(target);
    await expect(wrapped.ok()).resolves.toBe('value');
    await expect(wrapped.fail()).rejects.toThrow('rejected');
    await wrapped.outer();
    expect(calls.map(({ name, ok }) => [name, ok])).toEqual([
      ['ok', true],
      ['fail', false],
      ['outer', true],
    ]);
    expect(calls.every((c) => c.ms >= 0)).toBe(true);
  });

  it('events 를 켜면 함수 인자를 감싸 그 메서드 이름으로 이벤트 종류를 센다', async () => {
    const { events, observer } = collector();
    setIpcObserver(observer);
    const received: unknown[] = [];
    const target = {
      async openRepo(_path: string, onEvent: (event: { type: string }) => void) {
        onEvent({ type: 'statusChanged' });
        onEvent({ type: 'refsChanged' });
        return 1;
      },
    };
    await observeMethods(target, { events: true }).openRepo('/r', (e) => received.push(e));
    expect(events).toEqual(['openRepo:statusChanged', 'openRepo:refsChanged']);
    expect(received).toHaveLength(2);
  });

  it('통로 처리기는 관찰자가 없어도 원래 처리기를 부르고, 종류 필드가 없으면 unknown 으로 센다', () => {
    const handler = vi.fn();
    const tapped = tapEvents('openFolder', handler);
    tapped({ type: 'folderChanged' });
    const { events, observer } = collector();
    setIpcObserver(observer);
    tapped({ kind: 'data' });
    tapped(42);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(events).toEqual(['openFolder:data', 'openFolder:unknown']);
  });
});
