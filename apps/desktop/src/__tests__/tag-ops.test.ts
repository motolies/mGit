// A6: tag 지울 곳 삭제의 순서·일부 실패·다를 때 답 (`store/tag-ops.ts`, TG-03~05). IPC 는 가짜 함수로 넣는다.

import type { TagDeleteItem, TagRefResult, TagRefStatus, TagSyncReport } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import {
  type DivergedChoice,
  runTagDelete,
  sameTagReport,
  type TagDeleteDeps,
  tagDeleteChangedAnything,
  tagDeleteComplete,
  tagDeletePlaces,
  tagDeleteProblems,
  tagResultText,
} from '../store/tag-ops';

const R_OID = 'f'.repeat(40);
const R_COMMIT = 'e'.repeat(40);
const L_COMMIT = 'd'.repeat(40);

/** 결과 한 줄 */
const res = (
  name: string,
  status: TagRefStatus,
  extra: Partial<TagRefResult> = {},
): TagRefResult => ({
  name,
  status,
  message: null,
  remoteOid: null,
  remoteCommit: null,
  ...extra,
});

/** 원격 tag 표 흉내: 원격마다 이름 → 객체. 로컬과 다르면 diverged, `expectedRemote` 가 맞으면 지운다 */
function fakeRemote(opts: {
  tables: Record<string, Record<string, string>>;
  local: Record<string, string>;
  /** 지금 코어: 다른 것이 있어도 나머지를 지운다. false 면 H2 계약(아무것도 지우지 않고 나머지는 처리 안 됨) */
  deleteOthers?: boolean;
  /** 명령 전체가 실패하는 원격 */
  failing?: string[];
  /** 서버가 거부하는 tag */
  rejected?: string[];
}) {
  const calls: { remote: string; items: TagDeleteItem[] }[] = [];
  const deleteRemote = vi.fn(async (remote: string, items: TagDeleteItem[]) => {
    calls.push({ remote, items: items.map((i) => ({ ...i })) });
    if (opts.failing?.includes(remote)) {
      throw new Error(`auth ${remote}`);
    }
    const table = opts.tables[remote] ?? {};
    const diverged = new Set(
      items
        .filter((i) => {
          const cur = table[i.name];
          const want = i.expectedRemote ?? opts.local[i.name];
          // 로컬에 없는 tag(원격에만)는 견주지 않는다 (코어·목과 같다)
          return cur !== undefined && want !== undefined && cur !== want;
        })
        .map((i) => i.name),
    );
    if (opts.deleteOthers === false && diverged.size > 0) {
      return items.map((i) =>
        diverged.has(i.name)
          ? res(i.name, 'diverged', { remoteOid: table[i.name] ?? null, remoteCommit: R_COMMIT })
          : res(i.name, 'notRun'),
      );
    }
    return items.map((i) => {
      if (diverged.has(i.name)) {
        return res(i.name, 'diverged', {
          remoteOid: table[i.name] ?? null,
          remoteCommit: R_COMMIT,
        });
      }
      if (table[i.name] === undefined) {
        return res(i.name, 'alreadyAbsent');
      }
      if (opts.rejected?.includes(i.name)) {
        return res(i.name, 'rejectedRemote', { message: 'pre-receive hook declined' });
      }
      delete table[i.name];
      return res(i.name, 'deleted');
    });
  });
  return { deleteRemote, calls };
}

/** 의존 묶음 */
function deps(
  remote: ReturnType<typeof fakeRemote>,
  choice: DivergedChoice | null = null,
  order: string[] = [],
): TagDeleteDeps & { deleteLocal: ReturnType<typeof vi.fn>; onDiverged: ReturnType<typeof vi.fn> } {
  const deleteLocal = vi.fn(async (names: string[]) => {
    order.push(`local:${names.join(',')}`);
  });
  const onDiverged = vi.fn(async () => choice ?? 'cancel');
  return {
    deleteRemote: async (r, items) => {
      order.push(`remote:${r}`);
      return remote.deleteRemote(r, items);
    },
    deleteLocal,
    localCommit: () => L_COMMIT,
    onDiverged,
    describe: (e) => (e instanceof Error ? e.message : String(e)),
  };
}

describe('runTagDelete 순서와 일부 실패 (TG-05)', () => {
  it('고른 원격들을 먼저, 로컬은 마지막에 한 번. 모두 지운 tag 만 로컬에서 지운다', async () => {
    const remote = fakeRemote({
      tables: { origin: { v1: 'a', v2: 'b' }, upstream: { v1: 'a' } },
      local: { v1: 'a', v2: 'b', v3: 'c' },
      rejected: [],
    });
    const order: string[] = [];
    const d = deps(remote, null, order);
    const s = await runTagDelete(
      ['v1', 'v2', 'v1'],
      { local: true, remotes: ['origin', 'upstream'] },
      d,
    );
    expect(order).toEqual(['remote:origin', 'remote:upstream', 'local:v1,v2']);
    expect(s.names).toEqual(['v1', 'v2']);
    expect(s.remote.upstream?.map((r) => r.status)).toEqual(['deleted', 'alreadyAbsent']);
    expect(s.localDeleted).toEqual(['v1', 'v2']);
    expect(tagDeleteComplete(s)).toBe(true);
    expect(tagDeletePlaces(s.scope)).toBe(`${S.tag.del.local} · origin · upstream`);
  });

  it('서버가 거부한 tag 는 로컬에 남기고, 통째로 실패한 원격의 tag 는 모두 로컬에 남긴다. 다음 원격은 계속한다', async () => {
    const remote = fakeRemote({
      tables: { origin: { v1: 'a', v2: 'b' }, upstream: { v1: 'a', v2: 'b' } },
      local: { v1: 'a', v2: 'b' },
      rejected: ['v2'],
      failing: [],
    });
    const d = deps(remote);
    const s = await runTagDelete(['v1', 'v2'], { local: true, remotes: ['origin'] }, d);
    expect(s.localDeleted).toEqual(['v1']);
    expect(s.localKept).toEqual(['v2']);
    expect(tagDeleteComplete(s)).toBe(false);
    expect(tagDeleteProblems(s)).toBe(
      [
        S.tag.del.remoteFailed(
          'origin',
          `v2 (${S.error.remoteRejected('pre-receive hook declined')})`,
        ),
        S.tag.del.localKept('v2'),
      ].join(' · '),
    );

    const broken = fakeRemote({
      tables: { origin: { v1: 'a' }, upstream: { v1: 'a' } },
      local: { v1: 'a' },
      failing: ['origin'],
    });
    const order: string[] = [];
    const t = await runTagDelete(
      ['v1'],
      { local: true, remotes: ['origin', 'upstream'] },
      deps(broken, null, order),
    );
    expect(order).toEqual(['remote:origin', 'remote:upstream']);
    expect(t.remoteErrors).toEqual({ origin: 'auth origin' });
    expect(t.remote.upstream?.map((r) => r.status)).toEqual(['deleted']);
    expect(t.localKept).toEqual(['v1']);
    expect(t.localDeleted).toEqual([]);
  });

  it('로컬만이면 원격을 부르지 않고, 로컬 실패는 모두 남긴 것으로 보고한다', async () => {
    const remote = fakeRemote({ tables: {}, local: { v1: 'a' } });
    const d = deps(remote);
    d.deleteLocal.mockRejectedValueOnce(new Error('없는 tag'));
    const s = await runTagDelete(['v1'], { local: true, remotes: [] }, d);
    expect(remote.deleteRemote).not.toHaveBeenCalled();
    expect(s.localError).toBe('없는 tag');
    expect(s.localKept).toEqual(['v1']);
    expect(tagDeleteProblems(s)).toBe(
      [S.tag.del.localFailed('없는 tag'), S.tag.del.localKept('v1')].join(' · '),
    );
  });
});

describe('runTagDelete 로컬에 없는 tag (C4: 문서의 선택에 원격에만 있는 tag)', () => {
  it('로컬에 없는 tag 는 로컬 삭제 대상도 "로컬에 남김"도 아니다', async () => {
    const remote = fakeRemote({ tables: { origin: { v1: 'a', r1: 'x' } }, local: { v1: 'a' } });
    const d = { ...deps(remote), isLocal: (name: string) => name === 'v1' };
    const s = await runTagDelete(['v1', 'r1'], { local: true, remotes: ['origin'] }, d);
    expect(d.deleteLocal).toHaveBeenCalledWith(['v1']);
    expect(s.localDeleted).toEqual(['v1']);
    expect(s.localKept).toEqual([]);
    expect(tagDeleteComplete(s)).toBe(true);
  });
});

describe('runTagDelete 원격 것이 다를 때 (TG-04 ③, 결정: 콜백 + 세 갈래)', () => {
  /** origin: v1 다름(원격 R_OID), v2 같음 */
  const setup = (deleteOthers: boolean, choice: DivergedChoice) => {
    const remote = fakeRemote({
      tables: { origin: { v1: R_OID, v2: 'b' } },
      local: { v1: 'a', v2: 'b' },
      deleteOthers,
    });
    return { remote, d: deps(remote, choice) };
  };

  for (const deleteOthers of [true, false]) {
    const contract = deleteOthers
      ? '지금 코어(나머지는 지움)'
      : 'H2 코어(아무것도 안 지움, notRun)';

    it(`${contract}: 그래도 → 다른 것은 받은 원격 값으로, 성공 못 한 것만 다시 부르고 로컬까지`, async () => {
      const { remote, d } = setup(deleteOthers, 'all');
      const s = await runTagDelete(['v1', 'v2'], { local: true, remotes: ['origin'] }, d);
      expect(d.onDiverged).toHaveBeenCalledWith(
        [
          {
            remote: 'origin',
            name: 'v1',
            remoteOid: R_OID,
            remoteCommit: R_COMMIT,
            localCommit: L_COMMIT,
          },
        ],
        1,
      );
      expect(remote.calls[1]?.items).toEqual(
        deleteOthers
          ? [{ name: 'v1', expectedRemote: R_OID }]
          : [{ name: 'v1', expectedRemote: R_OID }, { name: 'v2' }],
      );
      expect(s.remote.origin?.map((r) => r.status)).toEqual(['deleted', 'deleted']);
      expect(s.localDeleted).toEqual(['v1', 'v2']);
      expect(tagDeleteComplete(s)).toBe(true);
    });

    it(`${contract}: 건너뛰기 → 다른 것은 빼고, 로컬도 다른 것은 남긴다`, async () => {
      const { remote, d } = setup(deleteOthers, 'skip');
      const s = await runTagDelete(['v1', 'v2'], { local: true, remotes: ['origin'] }, d);
      expect(remote.calls.length).toBe(deleteOthers ? 1 : 2);
      if (!deleteOthers) {
        expect(remote.calls[1]?.items).toEqual([{ name: 'v2' }]);
      }
      expect(s.remote.origin?.map((r) => r.status)).toEqual(['diverged', 'deleted']);
      expect(s.localDeleted).toEqual(['v2']);
      expect(s.localKept).toEqual(['v1']);
    });

    it(`${contract}: 취소 → 다시 부르지 않고 로컬도 건드리지 않는다`, async () => {
      const { remote, d } = setup(deleteOthers, 'cancel');
      const s = await runTagDelete(
        ['v1', 'v2'],
        { local: true, remotes: ['origin', 'upstream'] },
        d,
      );
      expect(remote.calls.map((c) => c.remote)).toEqual(['origin']);
      expect(d.deleteLocal).not.toHaveBeenCalled();
      expect(s.cancelled).toBe(true);
      expect(s.localKept).toEqual(['v1', 'v2']);
      // 지금 코어는 v2 를 이미 지웠으니 알리고, H2 코어는 바뀐 것이 없으니 알리지 않는다
      expect(tagDeleteChangedAnything(s)).toBe(deleteOthers);
    });
  }

  it('다른 것뿐이면 건너뛸 것이 없다고(others 0) 묻고, 묻는 함수가 없으면 취소로 본다', async () => {
    const remote = fakeRemote({ tables: { origin: { v1: R_OID } }, local: { v1: 'a' } });
    const d = deps(remote, 'cancel');
    await runTagDelete(['v1'], { local: false, remotes: ['origin'] }, d);
    expect(d.onDiverged.mock.calls[0]?.[1]).toBe(0);
    const silent = await runTagDelete(
      ['v1'],
      { local: true, remotes: ['origin'] },
      { ...deps(remote), onDiverged: undefined },
    );
    expect(silent.cancelled).toBe(true);
  });

  it('다시 부른 명령이 통째로 실패하면 첫 결과를 남기고 그 원격의 오류로 보고한다', async () => {
    const remote = fakeRemote({ tables: { origin: { v1: R_OID } }, local: { v1: 'a' } });
    const d = deps(remote, 'all');
    const real = d.deleteRemote;
    let n = 0;
    d.deleteRemote = async (r, items) => {
      n += 1;
      if (n === 2) {
        throw new Error('연결 끊김');
      }
      return real(r, items);
    };
    const s = await runTagDelete(['v1'], { local: true, remotes: ['origin'] }, d);
    expect(s.remote.origin?.map((r) => r.status)).toEqual(['diverged']);
    expect(s.remoteErrors.origin).toBe('연결 끊김');
    expect(s.localKept).toEqual(['v1']);
  });
});

describe('결과 사유 문구', () => {
  it('서버 거부는 서버 사유, 실패는 git 원문, 확인 대기는 "확인 대기"', () => {
    expect(tagResultText(res('v', 'rejectedRemote', { message: 'protected' }))).toBe(
      S.error.remoteRejected('protected'),
    );
    expect(tagResultText(res('v', 'failed', { message: 'src refspec' }))).toBe('src refspec');
    expect(tagResultText(res('v', 'failed'))).toBe(S.tag.status.failed);
    expect(tagResultText(res('v', 'unknown'))).toBe(S.tag.status.unknown);
    // 확인 대기(C2a)는 실패가 아니라 따로 부른다
    expect(tagResultText(res('v', 'notRun'))).toBe(S.tag.status.notRun);
  });
});

describe('원격 tag 보고서를 값으로 견주기 (sameTagReport, 다시 받기의 상태 유지)', () => {
  const report = (): TagSyncReport => ({
    remote: 'origin',
    checkedAt: 1_000,
    stale: false,
    lastError: null,
    counts: { localOnly: 1, remoteOnly: 0, same: 3, diverged: 1, unknown: 0 },
    entries: [
      {
        name: 'v1',
        state: { kind: 'diverged', sameCommit: true },
        localObject: L_COMMIT,
        localCommit: L_COMMIT,
        remoteObject: R_OID,
        remoteCommit: L_COMMIT,
      },
      {
        name: 'v2',
        state: { kind: 'localOnly' },
        localObject: L_COMMIT,
        localCommit: L_COMMIT,
        remoteObject: null,
        remoteCommit: null,
      },
    ],
    pushUrlDiffers: false,
  });

  it('새로 받은 같은 값이면 같다 (없음은 null·undefined 모두)', () => {
    expect(sameTagReport(report(), report())).toBe(true);
    const loose = report();
    loose.lastError = undefined;
    loose.entries[1] = {
      ...loose.entries[1],
      remoteObject: undefined,
      remoteCommit: undefined,
    } as (typeof loose.entries)[number];
    expect(sameTagReport(report(), loose)).toBe(true);
  });

  it('확인 시각·오래됨·실패·개수·항목의 상태와 oid 가 하나라도 다르면 다르다', () => {
    const changed: ((r: TagSyncReport) => void)[] = [
      (r) => {
        r.checkedAt = 2_000;
      },
      (r) => {
        r.stale = true;
      },
      (r) => {
        r.pushUrlDiffers = true;
      },
      (r) => {
        r.lastError = { kind: 'network', at: 5, message: 'x' };
      },
      (r) => {
        r.counts = { ...r.counts, same: 4 };
      },
      (r) => {
        r.entries = r.entries.slice(0, 1);
      },
      (r) => {
        r.entries[0] = {
          ...r.entries[0],
          state: { kind: 'diverged', sameCommit: false },
        } as (typeof r.entries)[number];
      },
      (r) => {
        r.entries[0] = { ...r.entries[0], remoteObject: R_COMMIT } as (typeof r.entries)[number];
      },
      (r) => {
        r.entries[1] = { ...r.entries[1], name: 'v3' } as (typeof r.entries)[number];
      },
    ];
    for (const change of changed) {
      const r = report();
      change(r);
      expect(sameTagReport(report(), r)).toBe(false);
    }
    // 실패 기록은 시각까지 견준다 (같은 종류라도 새 실패)
    const a = report();
    const b = report();
    a.lastError = { kind: 'auth', at: 1, message: 'm' };
    b.lastError = { kind: 'auth', at: 2, message: 'm' };
    expect(sameTagReport(a, b)).toBe(false);
  });
});
