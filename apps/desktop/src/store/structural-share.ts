// 다시 읽은 값의 구조 공유 (G3): 코어 응답은 늘 새 배열·새 객체로 오므로, 그대로 스토어에 넣으면 바뀐 것이 없어도 구독한
// 화면이 모두 깬다. 지금 값과 모든 필드를 견줘 같은 부분은 옛 참조를 그대로 쓰고, 다른 부분만 새 참조로 둔다 — 전부 같으면
// 옛 값 자체를 돌려주므로 부르는 쪽은 참조가 같은지로 `set` 을 건너뛸 수 있다. 일부 필드만 보는 지문은 쓰지 않는다
// (보지 않은 필드가 바뀌면 화면이 낡는다). IPC 응답처럼 JSON 으로 나타낼 수 있는 값(원시값·배열·일반 객체)을 다룬다

/** 일반 객체(`{}` 리터럴·JSON 객체)인지. Map·Set·Date·클래스 인스턴스는 견주지 않고 늘 새 값으로 본다 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `next` 를 돌려주되 `prev` 와 같은 부분은 `prev` 의 참조로 바꾼다 (재귀). 배열은 같은 자리끼리, 객체는 같은 키끼리 견준다.
 * 전부 같으면 `prev` 자체를 돌려준다
 */
export function shareValue<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    const out = next.map((item, i) => shareValue(prev[i], item));
    const same = out.length === prev.length && out.every((item, i) => item === prev[i]);
    return (same ? prev : out) as T;
  }
  if (isRecord(prev) && isRecord(next)) {
    const out: Record<string, unknown> = {};
    let same = Object.keys(prev).length === Object.keys(next).length;
    for (const key of Object.keys(next)) {
      out[key] = Object.hasOwn(prev, key) ? shareValue(prev[key], next[key]) : next[key];
      if (out[key] !== prev[key] || !Object.hasOwn(prev, key)) same = false;
    }
    return (same ? prev : out) as T;
  }
  return next;
}

/**
 * 열쇠가 있는 목록을 다시 읽은 결과로 바꾸되, 같은 열쇠의 줄이 모든 필드까지 같으면 옛 줄의 참조를 쓴다 (다르면 그 줄 안에서도
 * 같은 부분은 옛 참조 — `shareValue`). 순서는 `next` 를 따른다. 줄 수·순서·참조가 모두 그대로면 옛 배열을 돌려준다 — 줄이 끼거나
 * 빠져도 나머지 줄은 옛 참조로 남아 행 단위 메모가 산다
 */
export function shareRows<T>(
  prev: readonly T[],
  next: readonly T[],
  keyOf: (row: T) => string,
): T[] {
  if (prev === next) return prev as T[];
  const byKey = new Map(prev.map((row) => [keyOf(row), row]));
  const out = next.map((row) => {
    const old = byKey.get(keyOf(row));
    return old === undefined ? row : shareValue(old, row);
  });
  const same = out.length === prev.length && out.every((row, i) => row === prev[i]);
  return same ? (prev as T[]) : out;
}
