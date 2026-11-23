import { type CommandLogRecord, createNullClient, type RepoSummary } from '@mgit/ipc';
import { describe, expect, it } from 'vitest';
import { commandFailed, LOG_CAPACITY, logRepoIndex, prependCapped } from '../store/command-log';
import { createFolderStore } from '../store/folder-store';

/** 폴더 콘솔 기록 하나 (쓰기 명령) */
function record(id: number, extra: Partial<CommandLogRecord> = {}): CommandLogRecord {
  return {
    id,
    args: ['fetch', '--all'],
    cwd: '/f/a',
    startedAt: 1_763_500_000_000 + id,
    elapsedMs: 12,
    status: 0,
    stderrTail: '',
    isWrite: true,
    cancelled: false,
    ...extra,
  };
}

/** 요약 한 줄 */
function summary(name: string, color: number): RepoSummary {
  return {
    path: `/f/${name}`,
    name,
    kind: 'standalone',
    color,
    branch: 'main',
    detached: false,
    changed: 0,
    conflicted: 0,
    ahead: null,
    behind: null,
    op: null,
    lastFetch: null,
    error: null,
  };
}

/** 빈 폴더 스토어 (읽기는 모두 빈 결과) */
function folder() {
  return createFolderStore({ session: 7, path: '/f', repos: [] }, createNullClient());
}

/** 폴더 콘솔 이벤트를 넣는다 */
function log(store: ReturnType<typeof folder>, repo: string, r: CommandLogRecord) {
  store.getState().applyEvent({ type: 'folderCommandLogged', session: 7, repo, record: r });
}

describe('명령 로그 공용 규칙 (W19 ②)', () => {
  it('새 기록을 앞에 붙이고 상한을 넘는 오래된 것을 버린다', () => {
    expect(prependCapped([2, 1], 3, 3)).toEqual([3, 2, 1]);
    expect(prependCapped([3, 2, 1], 4, 3)).toEqual([4, 3, 2]);
    expect(LOG_CAPACITY).toBe(500);
  });

  it('실패 = 취소가 아니고 종료 코드가 0 이 아님 (코드 없이 끝나도 실패)', () => {
    expect(commandFailed(record(1))).toBe(false);
    expect(commandFailed(record(1, { status: 1 }))).toBe(true);
    expect(commandFailed(record(1, { status: null }))).toBe(true);
    expect(commandFailed(record(1, { status: null, cancelled: true }))).toBe(false);
  });

  it('저장소 경로 → 요약의 이름·색. 요약에 없으면 마지막 이름에 색 없음. 같은 경로는 같은 객체', () => {
    const repoOf = logRepoIndex([summary('api', 3), summary('web', 12)]);
    expect(repoOf('/f/api')).toEqual({ path: '/f/api', name: 'api', color: 3 });
    expect(repoOf('/f/web').color).toBe(12);
    expect(repoOf('/f/gone/')).toEqual({ path: '/f/gone/', name: 'gone', color: null });
    expect(repoOf('/f/api')).toBe(repoOf('/f/api'));
    expect(repoOf('/f/gone/')).toBe(repoOf('/f/gone/'));
  });
});

describe('폴더 스토어의 콘솔 (W19 ②)', () => {
  it('folderCommandLogged 를 최신 순으로 저장소와 함께 모으고 상한을 지킨다', () => {
    const store = folder();
    expect(store.getState().commandLog).toEqual([]);
    log(store, '/f/a', record(1));
    log(store, '/f/b', record(2, { cwd: '/f/b-wt' }));
    expect(store.getState().commandLog).toEqual([
      { repo: '/f/b', record: record(2, { cwd: '/f/b-wt' }) },
      { repo: '/f/a', record: record(1) },
    ]);
    for (let i = 3; i <= LOG_CAPACITY + 5; i += 1) {
      log(store, '/f/a', record(i));
    }
    const entries = store.getState().commandLog;
    expect(entries).toHaveLength(LOG_CAPACITY);
    expect(entries[0]?.record.id).toBe(LOG_CAPACITY + 5);
    expect(entries.at(-1)?.record.id).toBe(6);
  });

  it('콘솔을 보지 않는 동안의 실패만 센다. 보기 시작하면 0, 그만 보면 다시 센다 (그만 보기를 두 번 불러도 한 번)', () => {
    const store = folder();
    log(store, '/f/a', record(1, { status: 1 }));
    log(store, '/f/a', record(2));
    log(store, '/f/a', record(3, { status: null, cancelled: true }));
    log(store, '/f/a', record(4, { status: 128 }));
    expect(store.getState().commandLogUnseenFailures).toBe(2);

    const stop = store.getState().viewCommandLog();
    expect(store.getState().commandLogUnseenFailures).toBe(0);
    log(store, '/f/a', record(5, { status: 1 }));
    expect(store.getState().commandLogUnseenFailures).toBe(0);
    // 두 화면이 함께 보다가 하나가 그만 봐도 아직 보는 중이다 (StrictMode 의 이중 마운트 포함)
    const other = store.getState().viewCommandLog();
    stop();
    stop();
    log(store, '/f/a', record(6, { status: 1 }));
    expect(store.getState().commandLogUnseenFailures).toBe(0);
    other();
    log(store, '/f/a', record(7, { status: 1 }));
    expect(store.getState().commandLogUnseenFailures).toBe(1);
    // 기록 자체는 보든 말든 다 쌓인다
    expect(store.getState().commandLog.map((e) => e.record.id)).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it('좁혀 볼 저장소를 정하고 되돌린다', () => {
    const store = folder();
    store.getState().setCommandLogRepo('/f/a');
    expect(store.getState().commandLogRepo).toBe('/f/a');
    store.getState().setCommandLogRepo(null);
    expect(store.getState().commandLogRepo).toBeNull();
  });
});
