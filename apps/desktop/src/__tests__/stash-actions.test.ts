// W23: Commit 도구 창 Stash 탭의 동작 (`stash-actions.ts`) — 옛 사이드바 스태시 섹션(`Sidebar.tsx`)·옛 상세
// (`StashDetail`)와의 대조. 기대값은 손대기 전 브라우저에서 모은 기준(스크래치패드 `w23/baseline-old-stash.json`)과 옛
// 코드의 값이다: 메뉴 4개의 라벨·순서·구분선·꺼짐·위험 표시, 저장 대화상자의 필드·기본값과 `stashPush` 인자, drop
// 확인창의 제목·문구·위험 표시, 누르면 부르는 세션 동작과 인자. 출처 정보 전의 대체 목록 규칙.

import type { StashEntry, StashInfo } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from '../components/ContextMenu';
import {
  dropStash,
  popStash,
  type StashDeps,
  saveStash,
  stashEntries,
  stashMenu,
  stashRowTitle,
  stashWriteBlocked,
} from '../features/commit/stash-actions';

/** 스태시 정보 하나 */
function info(index: number, ch: string, message: string): StashInfo {
  return {
    index,
    oid: ch.repeat(40),
    base: 'b'.repeat(40),
    message,
    time: 0,
    includesUntracked: false,
    branch: 'main',
  };
}

const A: StashEntry = { info: info(0, '1', 'WIP on main: A'), origin: null };
const B: StashEntry = { info: info(1, '2', 'On dev: B'), origin: '/repo-hotfix' };

/** 호출을 기록하는 동작 묶음. 대화상자는 정한 값으로 답한다 */
function deps(
  state: { busy: boolean; inOp: boolean } = { busy: false, inOp: false },
  answers: { confirm?: boolean; prompt?: Record<string, string | boolean> | null } = {},
  results: { pop?: boolean; drop?: boolean } = {},
) {
  const d = {
    state,
    session: {
      selectStash: vi.fn(async () => {}),
      stashPush: vi.fn(async () => {}),
      stashApply: vi.fn(async () => true),
      stashPop: vi.fn(async () => results.pop ?? true),
      stashDrop: vi.fn(async () => results.drop ?? true),
    },
    dialogs: {
      confirm: vi.fn(async () => answers.confirm ?? false),
      prompt: vi.fn(async () => answers.prompt ?? null),
    },
    onPopped: vi.fn(),
    onDropped: vi.fn(),
  };
  return d satisfies StashDeps;
}

/** 메뉴 항목의 모양 (구분선은 항목 앞에 `---`, 꺼짐 [off], 위험 [danger]) */
const shape = (items: MenuItem[]) =>
  items.flatMap((item) => [
    ...(item.separator ? ['---'] : []),
    `${item.label}${item.disabled ? ' [off]' : ''}${item.danger ? ' [danger]' : ''}`,
  ]);

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('스태시 목록 (옛 사이드바의 stashEntries)', () => {
  it('출처 정보(listStashes)가 있으면 그것, 아직 없고 refs 에 있으면 refs 의 목록을 출처 없이 보인다', () => {
    expect(stashEntries([A, B], [A.info])).toEqual([A, B]);
    expect(stashEntries([], [A.info, B.info])).toEqual([
      { info: A.info, origin: null },
      { info: B.info, origin: null },
    ]);
    expect(stashEntries([], [])).toEqual([]);
  });

  it('행의 툴팁은 출처 워크트리 경로가 있으면 그 경로, 없으면 메시지다', () => {
    expect(stashRowTitle(A)).toBe('WIP on main: A');
    expect(stashRowTitle(B)).toBe(S.sidebar.origin('/repo-hotfix'));
  });

  it('저장·apply·pop 은 실행 중이거나 진행 중 작업이 있으면 막힌다', () => {
    expect(stashWriteBlocked({ busy: false, inOp: false })).toBe(false);
    expect(stashWriteBlocked({ busy: true, inOp: false })).toBe(true);
    expect(stashWriteBlocked({ busy: false, inOp: true })).toBe(true);
  });
});

describe('우클릭 메뉴 (옛 사이드바 그대로)', () => {
  it('내용 보기 / ─ / apply / pop / drop…(위험). 평소에는 모두 켜져 있다', () => {
    expect(shape(stashMenu(A, deps()))).toEqual([
      '내용 보기',
      '---',
      '적용',
      '적용 후 삭제',
      '스태시 삭제… [danger]',
    ]);
  });

  it('실행 중이면 apply·pop·drop 이 꺼지고, 진행 중 작업이 있으면 apply·pop 만 꺼진다. 내용 보기는 늘 켜져 있다', () => {
    expect(shape(stashMenu(A, deps({ busy: true, inOp: false })))).toEqual([
      '내용 보기',
      '---',
      '적용 [off]',
      '적용 후 삭제 [off]',
      '스태시 삭제… [off] [danger]',
    ]);
    expect(shape(stashMenu(A, deps({ busy: false, inOp: true })))).toEqual([
      '내용 보기',
      '---',
      '적용 [off]',
      '적용 후 삭제 [off]',
      '스태시 삭제… [danger]',
    ]);
  });

  it('누르면: 내용 보기 = selectStash(항목), apply·pop = 그 oid 로 부른다. pop 이 성공하면 onPopped', async () => {
    const d = deps();
    const [show, apply, pop] = stashMenu(B, d);
    show?.onSelect?.();
    apply?.onSelect?.();
    pop?.onSelect?.();
    await flush();
    expect(d.session.selectStash).toHaveBeenCalledWith(B);
    expect(d.session.stashApply).toHaveBeenCalledWith(B.info.oid);
    expect(d.session.stashPop).toHaveBeenCalledWith(B.info.oid);
    expect(d.onPopped).toHaveBeenCalledTimes(1);
    expect(d.onDropped).not.toHaveBeenCalled();
  });

  it('drop… 은 위험 확인창(옛 제목·문구·삭제 단추) 뒤에만 지운다. 취소하면 부르지 않는다', async () => {
    const cancel = deps();
    stashMenu(B, cancel)[3]?.onSelect?.();
    await flush();
    expect(cancel.dialogs.confirm).toHaveBeenCalledWith({
      title: S.stash.dropTitle('stash@{1}'),
      message: S.stash.dropMessage,
      confirmLabel: S.dialog.delete,
      danger: true,
    });
    expect(S.stash.dropTitle('stash@{1}')).toBe('stash@{1}을(를) 지울까요?');
    expect(S.stash.dropMessage).toBe('지운 스태시는 되돌릴 수 없습니다.');
    expect(S.dialog.delete).toBe('삭제');
    expect(cancel.session.stashDrop).not.toHaveBeenCalled();
    expect(cancel.onDropped).not.toHaveBeenCalled();

    const ok = deps(undefined, { confirm: true });
    stashMenu(B, ok)[3]?.onSelect?.();
    await flush();
    expect(ok.session.stashDrop).toHaveBeenCalledWith(B.info.oid);
    expect(ok.onDropped).toHaveBeenCalledWith(B);
  });
});

describe('pop·drop 의 뒤 동작 (메뉴와 상세 단추가 같은 함수)', () => {
  it('pop 이 실패하면(false) onPopped 를 부르지 않는다', async () => {
    const d = deps(undefined, {}, { pop: false });
    await popStash(A.info.oid, d);
    expect(d.session.stashPop).toHaveBeenCalledWith(A.info.oid);
    expect(d.onPopped).not.toHaveBeenCalled();
  });

  it('drop 을 확인했지만 실패하면 onDropped 를 부르지 않고 false', async () => {
    const d = deps(undefined, { confirm: true }, { drop: false });
    expect(await dropStash(A, d)).toBe(false);
    expect(d.session.stashDrop).toHaveBeenCalledWith(A.info.oid);
    expect(d.onDropped).not.toHaveBeenCalled();
  });
});

describe('stash 저장 대화상자 (ST-01, 옛 사이드바 그대로)', () => {
  it('제목·필드(메시지, untracked 포함 = 기본 켜짐, staged 만)·만들기 단추. 취소하면 부르지 않는다', async () => {
    const d = deps();
    await saveStash(d);
    expect(d.dialogs.prompt).toHaveBeenCalledWith({
      title: S.stash.saveTitle,
      fields: [
        { key: 'message', label: S.stash.message },
        { key: 'untracked', label: S.stash.includeUntracked, type: 'checkbox', initial: true },
        { key: 'staged', label: S.stash.stagedOnly, type: 'checkbox' },
      ],
      confirmLabel: S.dialog.create,
    });
    expect([
      S.stash.saveTitle,
      S.stash.message,
      S.stash.includeUntracked,
      S.stash.stagedOnly,
    ]).toEqual([
      '스태시 저장',
      '메시지 (선택)',
      '미추적 파일 포함',
      '스테이징된 변경만 (--staged)',
    ]);
    expect(S.dialog.create).toBe('만들기');
    expect(d.session.stashPush).not.toHaveBeenCalled();
  });

  it('stashPush(메시지 또는 null, untracked, staged, [])', async () => {
    const empty = deps(undefined, { prompt: { message: '', untracked: true, staged: false } });
    await saveStash(empty);
    expect(empty.session.stashPush).toHaveBeenCalledWith(null, true, false, []);
    const named = deps(undefined, { prompt: { message: '실험', untracked: false, staged: true } });
    await saveStash(named);
    expect(named.session.stashPush).toHaveBeenCalledWith('실험', false, true, []);
  });
});
