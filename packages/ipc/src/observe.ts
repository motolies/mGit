// IPC 경계 관찰 (반응성 측정 M1). 개발·테스트 프로필의 성능 기록기만 관찰자를 건다. 관찰자가 없으면 감싼 함수는 원래
// 함수를 그대로 부르고(값 하나 확인), 이벤트 통로는 원래 처리기만 부른다.
import { commands } from './bindings';

/** IPC 호출과 코어 이벤트를 받는 쪽 (시각은 `performance.now()` 기준 ms) */
export interface IpcObserver {
  /** 호출 하나가 끝났다 (`name` 은 카멜 표기 명령·메서드 이름) */
  call(name: string, start: number, end: number, ok: boolean): void;
  /** 통로 `source`(그 통로를 연 명령 이름)로 이벤트 하나가 왔다. `type` 은 이벤트 종류 */
  event(source: string, type: string): void;
}

let observer: IpcObserver | null = null;

/** 관찰자를 건다 (null 이면 끈다). 앱에서는 기록기 설치가 한 번 부른다 */
export function setIpcObserver(next: IpcObserver | null): void {
  observer = next;
}

/** 값이 then 을 가진 약속인지 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/** 이벤트 객체의 종류 이름: 코어 이벤트는 `type`, 터미널 이벤트는 `kind`. 둘 다 없으면 'unknown' */
function eventType(event: unknown): string {
  if (typeof event === 'object' && event !== null) {
    const { type, kind } = event as { type?: unknown; kind?: unknown };
    if (typeof type === 'string') return type;
    if (typeof kind === 'string') return kind;
  }
  return 'unknown';
}

/** 이벤트 처리기를 감싸 관찰자에게 종류를 알린 뒤 원래 처리기를 부른다 */
export function tapEvents<E>(source: string, handler: (event: E) => void): (event: E) => void {
  return (event) => {
    const current = observer;
    if (current !== null) current.event(source, eventType(event));
    handler(event);
  };
}

/** 함수 하나를 감싼다. 관찰자가 없으면 그대로 부르고, 있으면 시작·끝 시각과 성공 여부를 알린다 */
function wrapMethod(
  name: string,
  fn: (...args: unknown[]) => unknown,
  self: object,
  events: boolean,
): (...args: unknown[]) => unknown {
  return (...args) => {
    const current = observer;
    if (current === null) return fn.apply(self, args);
    const callArgs = events
      ? args.map((arg) =>
          typeof arg === 'function' ? tapEvents(name, arg as (event: unknown) => void) : arg,
        )
      : args;
    const start = performance.now();
    let result: unknown;
    try {
      result = fn.apply(self, callArgs);
    } catch (error) {
      current.call(name, start, performance.now(), false);
      throw error;
    }
    if (!isThenable(result)) {
      current.call(name, start, performance.now(), true);
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        current.call(name, start, performance.now(), true);
        return value;
      },
      (error: unknown) => {
        current.call(name, start, performance.now(), false);
        throw error;
      },
    );
  };
}

/**
 * 객체의 함수 속성을 모두 감싼 새 객체를 만든다 (Tauri 명령 묶음·목 클라이언트 공용). 원래 함수는 원래 객체를 `this` 로
 * 부르므로 목 안의 `this.x()` 같은 내부 호출은 따로 세지 않는다. `events` 면 함수 인자(이벤트 처리기)도 감싸 그
 * 메서드 이름을 통로 이름으로 이벤트를 알린다 (목 클라이언트용 — Tauri 쪽은 `Channel` 을 만드는 자리에서 감싼다)
 */
export function observeMethods<T extends object>(target: T, options: { events?: boolean } = {}): T {
  const events = options.events === true;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(target)) {
    out[name] =
      typeof value === 'function'
        ? wrapMethod(name, value as (...args: unknown[]) => unknown, target, events)
        : value;
  }
  return out as T;
}

/**
 * 성능 기록 줄을 개발 실행 환경의 `perf.jsonl` 에 덧붙인다 (기록기 전용). 감싸지 않은 명령을 직접 불러 기록기 자신의
 * 쓰기는 기록되지 않는다. 결과가 false 면 파일이 상한에 닿아 더 받지 않는다. 배포 프로필에서는 코어가 거부한다
 */
export function perfAppend(lines: string): Promise<boolean> {
  return commands.perfAppend(lines);
}
