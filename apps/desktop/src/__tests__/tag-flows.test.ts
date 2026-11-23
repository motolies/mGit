// A6: tag 쓰기의 화면 흐름 (`features/tags/tag-flows.ts`, TG-01·03·04): push 항목 모양, 지울 곳 칸, 다를 때 확인의 갈래

import type { TagSyncReport } from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import {
  confirmAlignToLocal,
  confirmAlignToRemote,
  confirmDiverged,
  deleteScopeFields,
  deleteScopeNotice,
  deleteScopeOf,
  deleteSlowNotice,
  deleteTagsFlow,
  divergedLine,
  TAG_BATCH_SLOW_COUNT,
  type TagFlowDeps,
  tagPushItems,
  tagWriteItems,
} from '../features/tags/tag-flows';
import type { DivergedTag } from '../store/tag-ops';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/** 흐름 의존 묶음: 대화상자는 정한 답을 준다 */
function deps(
  over: Partial<Pick<TagFlowDeps, 'remotes' | 'busy'>> = {},
  answers: {
    confirm?: boolean;
    choice?: 'confirm' | 'secondary' | 'cancel';
    prompt?: Record<string, string | boolean> | null;
  } = {},
) {
  const session = {
    pushTags: vi.fn(async () => []),
    deleteTagsScoped: vi.fn(async () => undefined),
  };
  const dialogs = {
    confirm: vi.fn(async (_spec: unknown) => answers.confirm ?? true),
    confirmChoice: vi.fn(async (_spec: unknown) => answers.choice ?? 'cancel'),
    prompt: vi.fn(async (_spec: unknown) => answers.prompt ?? null),
  };
  const d: TagFlowDeps = { session, dialogs, remotes: ['origin'], busy: false, ...over };
  return { d, session, dialogs };
}

/** 다른 tag 하나 */
const diverged = (name: string, remoteCommit: string, localCommit: string): DivergedTag => ({
  remote: 'origin',
  name,
  remoteOid: 'c'.repeat(40),
  remoteCommit,
  localCommit,
});

describe('push 항목 (TG-01 ①⑦)', () => {
  it('원격 0 → 꺼진 항목, 1 → 평면, 2+ → 원격 이름 하위 메뉴. busy 일 때만 꺼진다', () => {
    expect(tagPushItems(['v1'], deps({ remotes: [] }).d)).toEqual([
      { label: S.tag.pushNoRemote, disabled: true },
    ]);
    const one = tagPushItems(['v1'], deps().d);
    expect(one.map((i) => [i.label, i.disabled])).toEqual([[S.remote.pushTo('origin'), false]]);
    const two = tagPushItems(['v1'], deps({ remotes: ['origin', 'upstream'], busy: true }).d);
    expect(two.map((i) => [i.label, i.disabled])).toEqual([[S.tag.pushMenu, true]]);
    expect(two[0]?.children?.map((c) => c.label)).toEqual(['origin', 'upstream']);
  });

  it('누르면 고른 원격으로 그 tag 만 push 한다', () => {
    const { d, session } = deps({ remotes: ['origin', 'upstream'] });
    tagPushItems(['v1', 'v2'], d)[0]?.children?.[1]?.onSelect?.();
    expect(session.pushTags).toHaveBeenCalledWith('upstream', ['v1', 'v2']);
  });

  it('쓰기 항목은 push 묶음 다음 삭제(위험)이고 삭제도 busy 일 때 꺼진다', () => {
    expect(
      tagWriteItems('v1', deps({ busy: true }).d).map((i) => [i.label, i.disabled, i.danger]),
    ).toEqual([
      [S.remote.pushTo('origin'), true, undefined],
      [S.menu.delete, true, true],
    ]);
  });
});

describe('지울 곳 칸 (TG-03 ①)', () => {
  it('"지울 곳" 묶음에 로컬(기본 체크, 되돌릴 수 있음)과 원격마다 빈 칸(확인 안 함 · 되돌릴 수 없음). 키는 차례', () => {
    const fields = deleteScopeFields(['origin', 'fork/x'], ['v1']);
    const note = (...parts: string[]) => parts.join(' · ');
    expect(fields.map((f) => [f.key, f.label, f.initial, f.note, f.group])).toEqual([
      [
        'local',
        S.tag.del.local,
        true,
        note(S.tag.del.applies(1), S.tag.del.localNote),
        S.tag.del.scope,
      ],
      [
        'remote0',
        'origin',
        false,
        note(S.tag.del.notChecked, S.tag.del.remoteNote),
        S.tag.del.scope,
      ],
      [
        'remote1',
        'fork/x',
        false,
        note(S.tag.del.notChecked, S.tag.del.remoteNote),
        S.tag.del.scope,
      ],
    ]);
    expect(
      deleteScopeOf({ local: false, remote0: true, remote1: true }, ['origin', 'fork/x']),
    ).toEqual({
      local: false,
      remotes: ['origin', 'fork/x'],
    });
  });
});

/** 확인한 보고서: 주어진 항목 말고는 "같음" */
const checked = (remote: string, entries: TagSyncReport['entries'] = []): TagSyncReport => ({
  remote,
  checkedAt: 1_000,
  stale: false,
  lastError: null,
  counts: { localOnly: 0, remoteOnly: 0, same: 0, diverged: 0, unknown: 0 },
  entries,
  pushUrlDiffers: false,
});
const localOnly = (name: string) => ({
  name,
  state: { kind: 'localOnly' as const },
  localObject: A,
  localCommit: A,
  remoteObject: null,
  remoteCommit: null,
});

describe('지울 곳 칸별 상태와 경고 (B5, TG-03 ⑥)', () => {
  // origin 확인함: v1 같음, v2 push 안 됨 / upstream 확인함: 둘 다 push 안 됨 / fork 확인 안 함
  const reports = {
    origin: checked('origin', [localOnly('v2')]),
    upstream: checked('upstream', [localOnly('v1'), localOnly('v2')]),
  };
  const remotes = ['origin', 'upstream', 'fork'];

  it('확인한 원격은 해당 개수, 해당이 0개면 끄고 사유. 확인 안 한 원격은 "확인 안 함"', () => {
    const fields = deleteScopeFields(remotes, ['v1', 'v2'], reports);
    expect(fields.map((f) => [f.key, f.disabled ?? false, f.note])).toEqual([
      ['local', false, `${S.tag.del.applies(2)} · ${S.tag.del.localNote}`],
      ['remote0', false, `${S.tag.del.applies(1)} · ${S.tag.del.remoteNote}`],
      ['remote1', true, S.tag.del.absent],
      ['remote2', false, `${S.tag.del.notChecked} · ${S.tag.del.remoteNote}`],
    ]);
  });

  it('경고: 로컬만이면 고르지 않은 원격에 남은 수(comeBack), 모든 원격을 확인했을 때만 어디에도 없는 수(unpushedWarn)', () => {
    expect(deleteScopeNotice({ local: true }, remotes, ['v1', 'v2'], reports)).toBe(
      S.tag.del.comeBack(1),
    );
    // origin 도 고르면 다시 생길 것이 없다
    expect(
      deleteScopeNotice({ local: true, remote0: true }, remotes, ['v1', 'v2'], reports),
    ).toBeNull();
    // 로컬을 고르지 않으면 경고가 없다
    expect(deleteScopeNotice({ remote0: true }, remotes, ['v1'], reports)).toBeNull();
    // 모든 원격을 확인했으면 어디에도 없는 v2 를 센다
    const two = ['origin', 'upstream'];
    expect(deleteScopeNotice({ local: true }, two, ['v1', 'v2'], reports)).toBe(
      `${S.tag.del.comeBack(1)} ${S.tag.del.unpushedWarn(1)}`,
    );
  });

  it('상태를 아는 원격이 있으면 설명문에서 K2 일반 안내를 빼고 칸별 경고를 쓴다. 모르면 일반 안내를 붙인다', async () => {
    const known = deps({ remotes: ['origin'] }, { prompt: null });
    await deleteTagsFlow(['v2'], { ...known.d, reports });
    const spec = known.dialogs.prompt.mock.calls[0]?.[0] as {
      message: string;
      notice: (v: Record<string, boolean>) => string | null;
    };
    expect(spec.message).toBe(S.tag.del.message);
    // origin 만 있고 확인했다: v2 는 어디에도 없다
    expect(spec.notice({ local: true })).toBe(S.tag.del.unpushedWarn(1));
    const unknown = deps({}, { prompt: null });
    await deleteTagsFlow(['v1'], unknown.d);
    expect(unknown.dialogs.prompt.mock.calls[0]?.[0]).toHaveProperty(
      'message',
      `${S.tag.del.message} ${S.tag.del.comeBackMaybe}`,
    );
  });
});

describe('원격에만 있는 tag 가 섞인 삭제 (C4)', () => {
  it('고른 것이 모두 원격에만 있으면 로컬 칸을 끄고 사유, 섞였으면 로컬 칸 해당 개수는 로컬에 있는 것만', () => {
    const none = deleteScopeFields(['origin'], ['r1', 'r2'], {}, 0);
    expect(none[0]).toMatchObject({ key: 'local', disabled: true, note: S.tag.del.notLocal });
    const mixed = deleteScopeFields(['origin'], ['v1', 'r1'], {}, 1);
    expect(mixed[0]?.note).toBe(`${S.tag.del.applies(1)} · ${S.tag.del.localNote}`);
  });

  it('흐름은 지울 곳과 요약을 돌려주고, 조용히(문서)면 세션에 그렇게 넘긴다', async () => {
    const summary = { names: ['v1'] };
    const { d, session } = deps({}, { prompt: { local: true, remote0: true } });
    session.deleteTagsScoped.mockResolvedValueOnce(summary as never);
    const done = await deleteTagsFlow(['v1'], { ...d, isLocal: () => true }, { silent: true });
    expect(done).toEqual({ summary, scope: { local: true, remotes: ['origin'] } });
    expect(session.deleteTagsScoped.mock.calls[0]?.[2 as never]).toMatchObject({ silent: true });
  });
});

describe('삭제 흐름 (TG-03)', () => {
  it('여러 tag 는 tag 목록(items)을 보이고, 아무 칸도 고르지 않으면 확인이 꺼진다', async () => {
    const { d, dialogs, session } = deps({}, { prompt: null });
    await deleteTagsFlow(['v1', 'v2', 'v1'], d);
    const spec = dialogs.prompt.mock.calls[0]?.[0] as {
      title: string;
      items: string[];
      danger: boolean;
      validate: (v: Record<string, boolean>) => string | null;
    };
    expect(spec.title).toBe(S.tag.del.titleMany(2));
    expect(spec.items).toEqual(['v1', 'v2']);
    expect(spec.danger).toBe(true);
    expect(spec.validate({ local: false, remote0: false })).toBe(S.tag.del.none);
    expect(spec.validate({ local: false, remote0: true })).toBeNull();
    expect(session.deleteTagsScoped).not.toHaveBeenCalled();
  });

  it('지울 곳의 "다를 때" 콜백은 같은 대화상자로 묻는다', async () => {
    const { d, dialogs, session } = deps(
      {},
      { prompt: { local: true, remote0: true }, confirm: true },
    );
    await deleteTagsFlow(['v1'], d);
    const opts = session.deleteTagsScoped.mock.calls[0]?.[2 as never] as unknown as {
      onDiverged: (items: DivergedTag[], others: number) => Promise<string>;
    };
    expect(await opts.onDiverged([diverged('v1', A, B)], 0)).toBe('all');
    expect(dialogs.confirm).toHaveBeenCalledTimes(1);
  });
});

describe('다를 때 확인 (TG-04 ③)', () => {
  it('다르지 않은 tag 가 없으면 두 갈래(confirm), 있으면 세 갈래(confirmChoice) — 위험 확인에 두 commit', async () => {
    const items = [diverged('v1', A, B)];
    const two = deps({}, { confirm: false });
    expect(await confirmDiverged(two.dialogs, items, 0)).toBe('cancel');
    expect(two.dialogs.confirm).toHaveBeenCalledWith({
      title: S.tag.differs.title('origin', 1),
      message: S.tag.differs.message,
      items: [S.tag.differs.item('v1', shortHash(A), shortHash(B))],
      confirmLabel: S.tag.differs.deleteAnyway,
      danger: true,
    });
    expect(two.dialogs.confirmChoice).not.toHaveBeenCalled();
    for (const [choice, expected] of [
      ['confirm', 'all'],
      ['secondary', 'skip'],
      ['cancel', 'cancel'],
    ] as const) {
      const three = deps({}, { choice });
      expect(await confirmDiverged(three.dialogs, items, 2)).toBe(expected);
      expect(three.dialogs.confirmChoice.mock.calls[0]?.[0]).toMatchObject({
        secondaryLabel: S.tag.differs.skip,
        danger: true,
      });
    }
  });

  it('같은 commit 이면 tag 객체만 다르다고 쓴다', () => {
    expect(divergedLine(diverged('v2', A, A))).toBe(
      S.tag.differs.itemSameCommit('v2', shortHash(A)),
    );
  });
});

describe('다름 해소 확인 (C5, TG-15)', () => {
  it('원격 것으로: 일반 확인(위험 아님)에 두 commit. 로컬 것으로: 위험 확인에 두 commit 과 되돌릴 수 없음', async () => {
    const { dialogs } = deps({}, { confirm: true });
    expect(
      await confirmAlignToRemote(dialogs, 'origin', 'v1', { remoteCommit: A, localCommit: B }),
    ).toBe(true);
    expect(dialogs.confirm.mock.calls[0]?.[0]).toEqual({
      title: S.tag.align.toRemoteTitle('v1', 'origin'),
      message: S.tag.align.toRemoteMessage,
      items: [S.tag.differs.item('v1', shortHash(A), shortHash(B))],
      confirmLabel: S.tag.align.toRemoteConfirm,
    });
    await confirmAlignToLocal(dialogs, 'origin', [
      { name: 'v1', expectedRemote: 'c'.repeat(40), remoteCommit: A, localCommit: B },
    ]);
    expect(dialogs.confirm.mock.calls[1]?.[0]).toEqual({
      title: S.tag.align.toLocalTitle(1, 'origin'),
      message: S.tag.align.toLocalMessage,
      items: [S.tag.differs.item('v1', shortHash(A), shortHash(B))],
      confirmLabel: S.tag.align.toLocalConfirm,
      danger: true,
    });
  });
});

describe('대량 일괄 작업의 시간 안내 (C4 보강, B4)', () => {
  it('원격을 고르고 원격에 보낼 tag 가 500개 이상이면 안내, 499개면 없다. 로컬만이면 없다', () => {
    expect(TAG_BATCH_SLOW_COUNT).toBe(500);
    const remote = { local: true, remote0: true };
    expect(deleteSlowNotice(remote, ['origin'], 499)).toBeNull();
    expect(deleteSlowNotice(remote, ['origin'], 500)).toBe(S.tag.batch.slow);
    expect(deleteSlowNotice({ local: true }, ['origin'], 5000)).toBeNull();
  });

  it('지울 곳 대화상자의 경고 줄에 붙는다 (경계 499·500)', async () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    const notice = async (n: number) => {
      const { d, dialogs } = deps({}, { prompt: null });
      await deleteTagsFlow(names(n), d);
      const spec = dialogs.prompt.mock.calls[0]?.[0] as {
        notice: (v: Record<string, boolean>) => string | null;
      };
      return spec.notice({ local: true, remote0: true });
    };
    expect(await notice(499)).toBeNull();
    expect(await notice(500)).toBe(S.tag.batch.slow);
  });
});
