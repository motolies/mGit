// 실제 앱 성능 기록기의 핵심 (반응성 측정 M1): 줄을 모아 두었다가 한꺼번에 내보낸다. DOM·React·스토어를 모른다 —
// 프레임·입력·렌더 관찰은 `browser.ts`·`renders.ts`, 켜는 조건은 `mode.ts` 가 맡는다.

/** 기록 한 줄. `t` 는 앱 시작(문서 시간 원점) 기준 ms, `kind` 는 줄의 종류 */
export interface PerfEntry {
  t: number;
  kind: string;
  [field: string]: unknown;
}

/** 줄 묶음을 받는 곳 (파일 모드). false 를 주면 상한에 닿은 것이라 기록을 멈춘다 */
export interface PerfSink {
  write(lines: string): Promise<boolean>;
}

export interface RecorderOptions {
  /** 지금 시각 (ms, `performance.now()` 와 같은 원점) */
  now: () => number;
  /** 파일 모드의 내보낼 곳. null 이면 메모리 모드 (내보내지 않고 `entries()` 로만 읽는다) */
  sink: PerfSink | null;
  /** 내보내기 주기 (ms, 기본 2초) — 처음 쌓인 줄부터 잰다 */
  flushMs?: number;
  /** 이만큼 쌓이면 주기를 기다리지 않고 내보낸다 (기본 500) */
  flushCount?: number;
  /** 메모리 모드에서 간직할 최대 줄 수 (넘으면 오래된 절반을 버린다, 기본 200,000) */
  memoryLimit?: number;
  /** 타이머 (테스트가 바꾼다) */
  setTimer?: (fn: () => void, ms: number) => void;
}

export interface PerfRecorder {
  /** 줄 하나를 더한다 */
  push(entry: PerfEntry): void;
  /** IPC 호출 하나 (기록기 자신의 쓰기 명령은 버린다) */
  ipc(name: string, start: number, end: number, ok: boolean): void;
  /** 1초 단위로 묶어 셀 값 하나를 더한다 (`kind` 마다 따로 묶는다: 이벤트 종류별 수, 영역별 렌더 수) */
  count(kind: string, key: string, n?: number): void;
  /** 지난 초의 묶음을 닫고 쌓인 줄을 내보낸다 (메모리 모드는 묶음만 닫는다) */
  flush(): Promise<void>;
  /** 메모리 모드에서 모은 줄 (지난 초의 묶음을 닫은 뒤). 파일 모드는 아직 내보내지 않은 줄 */
  entries(): readonly PerfEntry[];
  /** 메모리 모드에서 모은 줄을 비운다 (열린 묶음도 버린다 — 측정 구간의 시작) */
  clear(): void;
  /** 이번 초의 묶음까지 모두 닫는다 (측정 구간의 끝 — 그 뒤 `entries()` 가 구간 전부를 준다) */
  cut(): void;
}

/** 기록기 자신의 쓰기 (관찰 경로로 들어와도 기록하지 않는다) */
const SELF_CALLS = new Set(['perfAppend', 'perf_append']);

/** 기록기 자신의 쓰기 명령인지 (앱 활동으로 세지 않는다 — 자가 진단의 "잠잠함" 판단) */
export const isSelfCall = (name: string): boolean => SELF_CALLS.has(name);

/** 소수 첫째 자리 */
export const round = (n: number): number => Math.round(n * 10) / 10;

/** 1초 묶음 하나 */
interface Bucket {
  sec: number;
  counts: Record<string, number>;
}

/** 기록기를 만든다. 호출마다 하는 일은 객체 하나를 배열에 넣는 것뿐이고, 직렬화는 내보낼 때 묶음으로 한다 */
export function createRecorder(options: RecorderOptions): PerfRecorder {
  const { now, sink } = options;
  const flushMs = options.flushMs ?? 2000;
  const flushCount = options.flushCount ?? 500;
  const memoryLimit = options.memoryLimit ?? 200_000;
  const setTimer = options.setTimer ?? ((fn, ms) => void setTimeout(fn, ms));
  const kept: PerfEntry[] = [];
  const buckets = new Map<string, Bucket>();
  let scheduled = false;
  let stopped = false;
  let writing: Promise<void> | null = null;

  /** 내보내기를 한 번 예약한다 (이미 예약했으면 그대로) */
  const schedule = () => {
    if (sink === null || scheduled || stopped) return;
    scheduled = true;
    setTimer(() => {
      scheduled = false;
      void recorder.flush();
    }, flushMs);
  };

  /** 줄을 간직한다 (메모리) 또는 내보낼 줄에 넣는다 (파일) */
  const add = (entry: PerfEntry) => {
    if (stopped) return;
    kept.push(entry);
    if (sink === null) {
      if (kept.length > memoryLimit) kept.splice(0, Math.floor(memoryLimit / 2));
      return;
    }
    if (kept.length >= flushCount) void recorder.flush();
    else schedule();
  };

  /** `kind` 의 묶음을 줄로 닫는다 */
  const close = (kind: string, bucket: Bucket) => {
    buckets.delete(kind);
    add({ t: bucket.sec * 1000, kind, counts: bucket.counts });
  };

  /** 지금 초보다 앞선 묶음을 모두 닫는다 */
  const closeStale = () => {
    const sec = Math.floor(now() / 1000);
    for (const [kind, bucket] of [...buckets]) {
      if (bucket.sec < sec) close(kind, bucket);
    }
  };

  const recorder: PerfRecorder = {
    push: add,
    ipc(name, start, end, ok) {
      if (SELF_CALLS.has(name)) return;
      add({ t: round(start), kind: 'ipc', name, ms: round(end - start), ok });
    },
    count(kind, key, n = 1) {
      const sec = Math.floor(now() / 1000);
      let bucket = buckets.get(kind);
      if (bucket && bucket.sec !== sec) {
        close(kind, bucket);
        bucket = undefined;
      }
      if (!bucket) {
        bucket = { sec, counts: {} };
        buckets.set(kind, bucket);
      }
      bucket.counts[key] = (bucket.counts[key] ?? 0) + n;
      schedule();
    },
    async flush() {
      closeStale();
      // 아직 열린 묶음(이번 초)은 다음 내보내기에서 닫는다
      if (buckets.size > 0) schedule();
      if (sink === null || stopped) return;
      while (writing) await writing;
      if (kept.length === 0) return;
      const lines = kept
        .splice(0)
        .map((entry) => JSON.stringify(entry))
        .join('\n');
      writing = sink.write(lines).then(
        (accepted) => {
          if (!accepted) stopped = true;
        },
        (error: unknown) => {
          // 쓰기가 거부되면(배포 프로필·권한 오류) 더 시도하지 않는다. 한 번만 알린다
          stopped = true;
          console.warn('mGit performance recorder stopped', error);
        },
      );
      try {
        await writing;
      } finally {
        writing = null;
      }
    },
    entries() {
      closeStale();
      return kept;
    },
    clear() {
      kept.splice(0);
      buckets.clear();
    },
    cut() {
      for (const [kind, bucket] of [...buckets]) close(kind, bucket);
    },
  };
  return recorder;
}
