// W27: 작업 진행 띠(폴더 탭·저장소 탭 공용 `OpBandView`·`OpRowView`·`IsolatedRowView`)의 키보드.
// 띠 전체가 Tab 정지 하나이고 안에서 2차원으로 옮긴다 — 줄 안 ←→·Home·End(막대 규칙, 끝에서 돈다), 줄 사이 ↑↓(목록 규칙,
// 끝에서 멈추고 같은 열에 가장 가까운 켜진 단추 — 거리가 같으면 왼쪽). 꺼진 단추·켜진 단추가 없는 줄은 건너뛴다.
// 누른 단추가 꺼지거나 그 줄이 사라지면 포커스를 띠에 두고(다른 저장소·"반영"의 단추로 저절로 가지 않는다), 띠가 통째로
// 사라지면 로그(없으면 에디터)로 옮긴다. 순수 이동 규칙(`rovingGridMove`)은 표로 확인한다.

import type { OpKind } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nearestColumn, rovingGridMove } from '../components/roving';
import { IsolatedRowView, OpBandView, OpRowView } from '../features/workspace/OpBand';
import type { AbortConfirm } from '../features/workspace/op-band';
import { tabStops } from './a11y-helpers';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

const CONFIRM: AbortConfirm = {
  title: '중단',
  message: '정말',
  confirmLabel: 'Abort',
  danger: true,
};

/** 띠의 줄 하나 */
interface RowSpec {
  name: string;
  kind: OpKind;
  conflicts: number;
  busy?: boolean;
  blocked?: string | null;
}

/** 줄들의 콜백 (누름 확인) */
const calls = { continue: vi.fn(), skip: vi.fn(), abort: vi.fn(), resolve: vi.fn() };

/** 폴더 탭처럼 저장소마다 한 줄인 띠. 로그·에디터 영역을 함께 둔다 (띠가 사라질 때 포커스가 갈 곳) */
function FolderBand({ rows, log = true }: { rows: RowSpec[]; log?: boolean }) {
  return (
    <>
      {log ? (
        <div data-panel="git-log" tabIndex={-1}>
          {/* biome-ignore lint/a11y/useSemanticElements: 테스트용 로그 흉내 */}
          <div role="grid" aria-label="로그" tabIndex={0} />
        </div>
      ) : null}
      <div data-panel="editor" tabIndex={-1} />
      <OpBandView count={rows.length}>
        {rows.map((r) => (
          <OpRowView
            key={r.name}
            kind={r.kind}
            label={r.name.toUpperCase()}
            conflicts={r.conflicts}
            busy={r.busy ?? false}
            subject={{ name: r.name, color: 1 }}
            blocked={r.blocked ?? null}
            abortConfirm={CONFIRM}
            onResolve={calls.resolve}
            resolveTitle="해결"
            onContinue={calls.continue}
            onSkip={calls.skip}
            onAbort={calls.abort}
          />
        ))}
      </OpBandView>
    </>
  );
}

/** 저장소 탭처럼 격리 병합 줄(위) + 작업 줄(아래)인 띠 */
function RepoBand({ op, applyBlocked }: { op: RowSpec | null; applyBlocked: string | null }) {
  return (
    <>
      <div data-panel="git-log" tabIndex={-1}>
        {/* biome-ignore lint/a11y/useSemanticElements: 테스트용 로그 흉내 */}
        <div role="grid" aria-label="로그" tabIndex={0} />
      </div>
      <OpBandView count={1 + (op ? 1 : 0)}>
        <IsolatedRowView
          branch="mgit/isolated-1"
          applyBlocked={applyBlocked}
          discardConfirm={CONFIRM}
          onApply={() => {}}
          onDiscard={() => {}}
        />
        {op ? (
          <OpRowView
            kind={op.kind}
            label={op.name}
            conflicts={op.conflicts}
            busy={op.busy ?? false}
            abortConfirm={CONFIRM}
            onResolve={calls.resolve}
            onContinue={calls.continue}
            onSkip={calls.skip}
            onAbort={calls.abort}
          />
        ) : null}
      </OpBandView>
    </>
  );
}

const band = () => screen.getByRole('region', { name: S.opBand.label });
const groups = () => within(band()).getAllByRole('group');
/** 그 줄의 단추 (대화상자 안의 것은 빼고) */
const button = (row: number, name: string | RegExp) =>
  within(groups()[row] as HTMLElement)
    .getAllByRole('button', { name, hidden: true })
    .find((b) => !b.closest('dialog')) as HTMLButtonElement;
/** 띠 안의 Tab 정지 */
const bandStops = () => tabStops(band());
/** 지금 포커스에 키 하나 */
const press = (key: string, mods: { metaKey?: boolean; shiftKey?: boolean } = {}) =>
  act(() => {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key, ...mods });
  });
const active = () => document.activeElement;

// 폴더 띠 세 줄: rebase 충돌 1 (충돌 수 3·해결 5·[Continue 꺼짐]·Skip 7·Abort 8), merge 충돌 없음 (Continue 6·Abort 8),
// cherry-pick 충돌 없음 (Continue 6·Skip 7·Abort 8)
const THREE: RowSpec[] = [
  { name: 'api', kind: 'rebase', conflicts: 1 },
  { name: 'billing', kind: 'merge', conflicts: 0 },
  { name: 'design', kind: 'cherryPick', conflicts: 0 },
];

beforeEach(() => {
  installDialogStub();
  for (const fn of Object.values(calls)) {
    fn.mockClear();
  }
});

afterEach(() => {
  cleanup();
  removeDialogStub();
});

describe('띠 안 이동 규칙 (순수 함수 rovingGridMove)', () => {
  const cols = [[3, 5, 7, 8], [6, 8], [], [6, 7, 8]];
  it.each([
    ['ArrowRight', { row: 0, index: 1 }, { row: 0, index: 2 }],
    ['ArrowRight', { row: 0, index: 3 }, { row: 0, index: 0 }], // 줄 안은 끝에서 돈다
    ['ArrowLeft', { row: 0, index: 0 }, { row: 0, index: 3 }],
    ['Home', { row: 0, index: 2 }, { row: 0, index: 0 }],
    ['End', { row: 1, index: 0 }, { row: 1, index: 1 }],
    ['ArrowDown', { row: 0, index: 2 }, { row: 1, index: 0 }], // 7 → 6·8 같은 거리면 왼쪽(6)
    ['ArrowDown', { row: 0, index: 1 }, { row: 1, index: 0 }], // 5 → 6
    ['ArrowDown', { row: 1, index: 1 }, { row: 3, index: 2 }], // 빈 줄은 건너뛴다 (8 → 8)
    ['ArrowUp', { row: 3, index: 1 }, { row: 1, index: 0 }], // 7 → 6
    ['ArrowUp', { row: 0, index: 0 }, null], // 줄 사이는 끝에서 멈춘다
    ['ArrowDown', { row: 3, index: 0 }, null],
    ['PageDown', { row: 0, index: 0 }, null],
    ['Enter', { row: 0, index: 0 }, null],
  ] as const)('%s %o → %o', (key, at, expected) => {
    expect(rovingGridMove(key, at, cols)).toEqual(expected);
  });

  it('가까운 열: 거리가 같으면 왼쪽 (결과가 가벼운 단추)', () => {
    expect(nearestColumn([3, 5, 7, 8], 6)).toBe(1);
    expect(nearestColumn([6, 8], 7)).toBe(0);
    expect(nearestColumn([8], 3)).toBe(0);
    expect(nearestColumn([], 3)).toBe(0);
  });
});

describe('작업 진행 띠의 키보드 (W27 — 폴더 띠 여러 줄)', () => {
  it('띠 전체가 Tab 정지 하나다. 확인창 안 단추의 tabindex 는 건드리지 않는다', () => {
    render(<FolderBand rows={THREE} />);
    expect(bandStops()).toHaveLength(1);
    // 처음 들어오면 첫 줄의 첫 켜진 단추
    expect(bandStops()[0]).toBe(button(0, /충돌 1/));
    for (const b of band().querySelectorAll('dialog button')) {
      expect(b.getAttribute('tabindex')).toBeNull();
    }
    // 줄 이름·단추 설명은 그대로 (W19 ③)
    expect(groups()[0]?.getAttribute('aria-labelledby')?.split(' ')).toHaveLength(2);
    expect(button(0, 'Abort').getAttribute('aria-describedby')).toBeTruthy();
  });

  it('줄 안 ←→ 는 꺼진 단추를 건너뛰고 끝에서 돈다. Home·End 는 그 줄의 처음·끝', () => {
    render(<FolderBand rows={THREE} />);
    act(() => button(0, /충돌 1/).focus());
    press('ArrowRight');
    expect(active()).toBe(button(0, S.opBand.resolve));
    press('ArrowRight'); // Continue 는 꺼져 있다 (충돌 남음)
    expect(active()).toBe(button(0, S.op.skip));
    press('ArrowRight');
    expect(active()).toBe(button(0, S.op.abort));
    press('ArrowRight');
    expect(active()).toBe(button(0, /충돌 1/));
    press('ArrowLeft');
    expect(active()).toBe(button(0, S.op.abort));
    press('Home');
    expect(active()).toBe(button(0, /충돌 1/));
    press('End');
    expect(active()).toBe(button(0, S.op.abort));
    // Tab 정지가 포커스를 따라간다
    expect(bandStops()).toEqual([button(0, S.op.abort)]);
  });

  it('줄 사이 ↑↓ 는 같은 열에 가장 가까운 켜진 단추로 가고 끝에서 멈춘다', () => {
    render(<FolderBand rows={THREE} />);
    act(() => button(0, S.op.skip).focus());
    press('ArrowDown'); // Skip(7) → merge 줄의 Continue(6)·Abort(8) 같은 거리 → 왼쪽
    expect(active()).toBe(button(1, S.op.continueLabel));
    press('ArrowDown'); // Continue(6) → cherry-pick 줄의 Continue(6)
    expect(active()).toBe(button(2, S.op.continueLabel));
    press('ArrowDown'); // 마지막 줄: 그대로
    expect(active()).toBe(button(2, S.op.continueLabel));
    press('ArrowUp');
    press('ArrowUp'); // Continue(6) → rebase 줄의 해결(5)·Skip(7) 같은 거리 → 왼쪽
    expect(active()).toBe(button(0, S.opBand.resolve));
    press('ArrowUp'); // 첫 줄: 그대로
    expect(active()).toBe(button(0, S.opBand.resolve));
  });

  it('켜진 단추가 없는 줄(busy)은 ↑↓ 에서 건너뛰고, 모든 줄이 busy 면 Tab 정지가 없다', () => {
    const { rerender } = render(
      <FolderBand rows={THREE.map((r, i) => (i === 1 ? { ...r, busy: true } : r))} />,
    );
    act(() => button(0, S.op.abort).focus());
    press('ArrowDown');
    expect(active()).toBe(button(2, S.op.abort));
    rerender(<FolderBand rows={THREE.map((r) => ({ ...r, busy: true }))} />);
    expect(bandStops()).toEqual([]);
  });

  it('세션 상한에 막힌 줄은 충돌 수·충돌 해결에만 닿는다', () => {
    render(<FolderBand rows={[{ name: 'api', kind: 'rebase', conflicts: 2, blocked: '상한' }]} />);
    act(() => button(0, /충돌 2/).focus());
    press('ArrowRight');
    expect(active()).toBe(button(0, S.opBand.resolve));
    press('ArrowRight');
    expect(active()).toBe(button(0, /충돌 2/));
  });

  it('Enter·Space 는 단추의 누름으로 남긴다 (띠가 막지 않는다). 수정키 조합은 옮기지 않는다', () => {
    render(<FolderBand rows={THREE} />);
    const skip = button(2, S.op.skip);
    act(() => skip.focus());
    expect(fireEvent.keyDown(skip, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(skip, { key: ' ' })).toBe(true);
    fireEvent.click(skip);
    expect(calls.skip).toHaveBeenCalledTimes(1);
    press('ArrowRight', { metaKey: true });
    press('ArrowDown', { shiftKey: true });
    expect(active()).toBe(skip);
  });

  it('다시 들어오면 마지막 단추. 그 줄이 사라졌으면 첫 켜진 단추 (다른 저장소의 같은 칸이 아니다)', () => {
    const { rerender } = render(<FolderBand rows={THREE} />);
    act(() => button(1, S.op.abort).focus());
    act(() => screen.getByRole('grid').focus());
    expect(bandStops()).toEqual([button(1, S.op.abort)]);
    rerender(<FolderBand rows={[THREE[0] as RowSpec, THREE[2] as RowSpec]} />);
    expect(bandStops()).toEqual([button(0, /충돌 1/)]);
  });

  it('누른 단추가 꺼지면(busy) 포커스를 띠에 두고, 다시 충돌하면 그 줄의 가장 가까운 단추로 돌아간다', () => {
    const rows = (design: Partial<RowSpec>) => [
      THREE[0] as RowSpec,
      THREE[1] as RowSpec,
      { ...(THREE[2] as RowSpec), ...design },
    ];
    const { rerender } = render(<FolderBand rows={rows({})} />);
    act(() => button(2, S.op.continueLabel).focus());
    rerender(<FolderBand rows={rows({ busy: true })} />);
    expect(active()).toBe(band());
    // 띠에 둔 포커스에서 화살표를 누르면 Tab 정지로 들어간다 — 여기서는 누르지 않고 결과를 기다린다
    rerender(<FolderBand rows={rows({ busy: false, conflicts: 1 })} />);
    // Continue(6) 는 충돌로 꺼졌다: 같은 줄의 해결(5)·Skip(7) 같은 거리 → 왼쪽
    expect(active()).toBe(button(2, S.opBand.resolve));
  });

  it('포커스가 있던 줄이 사라지면 띠에 두고, 남은 줄의 단추로 저절로 옮기지 않는다. 화살표로 다시 들어간다', () => {
    const { rerender } = render(<FolderBand rows={THREE} />);
    act(() => button(1, S.op.continueLabel).focus());
    rerender(<FolderBand rows={[THREE[0] as RowSpec, THREE[2] as RowSpec]} />);
    expect(active()).toBe(band());
    press('ArrowDown');
    expect(active()).toBe(button(0, /충돌 1/));
    // 띠를 떠나면 띠의 tabindex 를 거둔다
    expect(band().hasAttribute('tabindex')).toBe(false);
  });

  it('띠가 통째로 사라지면 그 안의 포커스를 로그로, 로그가 없으면 에디터로 옮긴다. 포커스가 밖이면 그대로', () => {
    const { rerender } = render(<FolderBand rows={THREE} />);
    act(() => button(2, S.op.abort).focus());
    rerender(<FolderBand rows={[]} />);
    expect(active()).toBe(screen.getByRole('grid'));
    cleanup();

    const second = render(<FolderBand rows={THREE} log={false} />);
    act(() => button(0, S.op.abort).focus());
    second.rerender(<FolderBand rows={[]} log={false} />);
    expect(active()?.getAttribute('data-panel')).toBe('editor');
    cleanup();

    const third = render(<FolderBand rows={THREE} />);
    act(() => screen.getByRole('grid').focus());
    act(() => (document.querySelector('[data-panel="editor"]') as HTMLElement).focus());
    third.rerender(<FolderBand rows={[]} />);
    expect(active()?.getAttribute('data-panel')).toBe('editor');
  });

  it('확인창 안의 화살표는 띠가 먹지 않는다', async () => {
    render(<FolderBand rows={THREE} />);
    fireEvent.click(button(2, S.op.abort));
    await tick();
    const dialog = band().querySelector('dialog[open]') as HTMLDialogElement;
    const cancel = within(dialog).getByRole('button', { name: S.confirm.cancel });
    expect(fireEvent.keyDown(cancel, { key: 'ArrowRight' })).toBe(true);
    expect(fireEvent.keyDown(cancel, { key: 'ArrowDown' })).toBe(true);
  });
});

describe('작업 진행 띠의 키보드 (W27 — 저장소 띠: 격리 줄 + 작업 줄)', () => {
  const MERGE: RowSpec = { name: 'MERGING', kind: 'merge', conflicts: 0 };

  it('두 줄이 Tab 정지 하나이고, ↑↓ 가 같은 열(Continue ↔ 반영, Abort ↔ 버리기)로 옮긴다', () => {
    render(<RepoBand op={MERGE} applyBlocked={null} />);
    expect(bandStops()).toHaveLength(1);
    act(() => button(1, S.op.continueLabel).focus());
    press('ArrowUp');
    expect(active()).toBe(button(0, S.preview.isolatedApply));
    press('ArrowRight');
    expect(active()).toBe(button(0, S.preview.isolatedDiscard));
    press('ArrowDown');
    expect(active()).toBe(button(1, S.op.abort));
  });

  it('반영이 막혀 있으면 격리 줄은 버리기에만 닿는다', () => {
    render(<RepoBand op={MERGE} applyBlocked="변경이 있습니다" />);
    act(() => button(1, S.op.continueLabel).focus());
    press('ArrowUp'); // Continue(6) → 반영(6)은 꺼짐 → 버리기(8)
    expect(active()).toBe(button(0, S.preview.isolatedDiscard));
  });

  it('Continue 로 작업 줄이 사라지고 반영이 켜져도 포커스는 반영에 가지 않고 띠에 남는다', () => {
    const { rerender } = render(<RepoBand op={MERGE} applyBlocked="진행 중인 작업" />);
    act(() => button(1, S.op.continueLabel).focus());
    rerender(<RepoBand op={{ ...MERGE, busy: true }} applyBlocked="진행 중인 작업" />);
    expect(active()).toBe(band());
    rerender(<RepoBand op={null} applyBlocked={null} />);
    expect(active()).toBe(band());
    expect(active()).not.toBe(button(0, S.preview.isolatedApply));
  });
});
