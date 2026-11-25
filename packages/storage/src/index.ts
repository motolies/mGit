export type SettingsSnapshot = Record<string, string>;
export type WriteSetting = (key: string, value: string | null) => Promise<void>;

export interface SettingsStorage extends Storage {
  flush(): Promise<void>;
  readonly pending: boolean;
}

/** 전송 실패나 손상된 파일을 빈 설정으로 오인하지 않도록 snapshot을 검증한다. */
export function parseSnapshot(value: unknown): SettingsSnapshot {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  ) {
    throw new Error('Invalid UI settings snapshot');
  }
  return value as SettingsSnapshot;
}

/** 변경을 즉시 반영하고 키별 저장을 직렬화한다. 실패한 항목은 flush 시 순서대로 재시도한다. */
export function createSettingsStorage(
  snapshot: SettingsSnapshot,
  write: WriteSetting,
  onError: (error: unknown) => void = console.error,
): SettingsStorage {
  const values = new Map(Object.entries(parseSnapshot(snapshot)));
  const queue: { key: string; value: string | null }[] = [];
  let running: Promise<void> | undefined;

  /** 실행 중인 저장 요청을 공유하고 실패 항목을 큐에 남긴다. */
  function drain(): Promise<void> {
    if (running) return running;
    if (!queue.length) return Promise.resolve();
    let failed = false;
    running = (async () => {
      while (queue.length) {
        const entry = queue[0];
        if (!entry) break;
        await write(entry.key, entry.value);
        queue.shift();
      }
    })()
      .catch((error: unknown) => {
        failed = true;
        throw error;
      })
      .finally(() => {
        running = undefined;
        if (!failed && queue.length) void drain();
      });
    void running.catch(onError);
    return running;
  }

  /** 실패를 알리되 비동기 예외가 유실되지 않도록 처리한다. */
  function enqueue(key: string, value: string | null): void {
    queue.push({ key, value });
    void drain();
  }

  return {
    get length() {
      return values.size;
    },
    get pending() {
      return queue.length > 0;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      values.set(key, value);
      enqueue(key, value);
    },
    removeItem(key) {
      values.delete(key);
      enqueue(key, null);
    },
    clear() {
      for (const key of values.keys()) enqueue(key, null);
      values.clear();
    },
    async flush() {
      while (queue.length) await drain();
    },
  };
}

let installed: SettingsStorage | undefined;

/** 앱 모듈을 불러오기 전에 환경별 저장소를 설치한다. undefined는 기존 배포용 localStorage다. */
export function installSettingsStorage(storage: SettingsStorage | undefined): void {
  installed = storage;
}

/** 모든 소비자가 같은 객체를 참조하고 배포 환경은 기존 localStorage 동작을 보존한다. */
export const settingsStorage: Storage = {
  get length() {
    return (installed ?? globalThis.localStorage).length;
  },
  key: (index) => (installed ?? globalThis.localStorage).key(index),
  getItem: (key) => (installed ?? globalThis.localStorage).getItem(key),
  setItem: (key, value) => (installed ?? globalThis.localStorage).setItem(key, value),
  removeItem: (key) => (installed ?? globalThis.localStorage).removeItem(key),
  clear: () => (installed ?? globalThis.localStorage).clear(),
};

/** 네이티브 종료 전에 미완료 설정을 저장하고 실패하면 종료를 막는다. */
export async function flushSettings(): Promise<void> {
  await installed?.flush();
}

/** 브라우저 새로고침 중 저장 요청이 유실될 수 있으면 이탈 확인을 요청한다. */
export function hasPendingSettings(): boolean {
  return installed?.pending ?? false;
}
