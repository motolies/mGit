// 비교 화면 ref 선택 칸 (F4) 컴포넌트: 열기·키보드·한글 조합 Enter·포커스 복귀·긴 이름·직접 입력 확인·빈 결과·현재 로컬 내용
import type { HeadState, RefLabel } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefPicker, type RefPickerProps } from '../features/history/RefPicker';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 시험용 ref 라벨 */
function label(fullName: string, current = false): RefLabel {
  const shortName = fullName.replace(/^refs\/(heads|remotes|tags)\//, '').replace(/^refs\//, '');
  const kind: RefLabel['kind'] = fullName.startsWith('refs/heads/')
    ? { kind: 'localBranch' }
    : fullName.startsWith('refs/remotes/')
      ? { kind: 'remoteBranch', remote: 'origin' }
      : fullName.startsWith('refs/tags/')
        ? { kind: 'tag', annotated: false }
        : { kind: 'stash' };
  return {
    fullName,
    shortName,
    kind,
    target: 'a'.repeat(40),
    isCurrent: current,
    upstreamGone: false,
  };
}

const head: HeadState = { state: 'attached', branch: 'main', oid: 'b'.repeat(40) };
const LONG = 'refs/remotes/origin/feat/multirepo-editor-batch1-with-a-very-long-description';
const labels = [
  label('refs/heads/main', true),
  label('refs/heads/develop'),
  label('refs/heads/feat/multirepo-editor-batch1'),
  label(LONG),
  label('refs/tags/v1.0.0'),
  label('refs/stash'),
];
const t = S.comparison.refPicker;
const LOCAL = '@LOCAL';
const local = {
  value: LOCAL,
  label: S.comparison.localContent,
  detail: S.comparison.includesDraft,
};

/** 칸을 그린다. 확정·확인 콜백은 목이다 */
function mount(props: Partial<RefPickerProps> = {}) {
  const onCommit = vi.fn<(value: string) => void>();
  const verify = vi.fn<(text: string) => Promise<void>>(async () => {});
  const all: RefPickerProps = {
    label: S.history.compareA,
    value: 'refs/heads/develop',
    refs: { head, labels },
    verify,
    onCommit,
    ...props,
  };
  const view = render(<RefPicker {...all} />);
  // 확인 목은 따로 주지 않았을 때만 쓴다 (주었으면 그 목을 테스트가 직접 본다)
  return { ...view, onCommit, verify };
}

/** 닫힌 칸 (팝오버를 여는 단추) */
function trigger(): HTMLElement {
  const button = screen
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-haspopup') === 'dialog');
  if (!button) throw new Error('칸이 없음');
  return button;
}
/** 열린 검색칸 (없으면 null) */
const combobox = () => screen.queryByRole('combobox');
/** 지금 활성 항목 (`aria-activedescendant` 가 가리키는 요소) */
function activeOption(): HTMLElement | null {
  const id = combobox()?.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
}
/** 열린 목록의 항목 이름들 */
const optionNames = () => screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'));

describe('닫힌 칸', () => {
  it('종류와 짧은 이름을 보이고 전체 이름은 툴팁이다', () => {
    mount();
    const button = trigger();
    expect(button.getAttribute('aria-label')).toBe(
      t.trigger(S.history.compareA, t.kind.local, 'develop'),
    );
    expect(button.title).toBe('refs/heads/develop');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('긴 이름은 마지막 / 앞뒤로 나눠 끝부분을 남기고, 전체 이름은 툴팁이다', () => {
    mount({ value: LONG });
    const button = trigger();
    expect(button.title).toBe(LONG);
    const spans = [...button.querySelectorAll('span')].map((s) => s.textContent);
    expect(spans).toContain('origin/feat/');
    expect(spans).toContain('multirepo-editor-batch1-with-a-very-long-description');
  });

  it('열린 목록은 긴 이름을 나누거나 줄이지 않고 전체를 보이며, `/` 뒤마다 줄바꿈 자리를 둔다', () => {
    mount({ value: LONG });
    fireEvent.click(trigger());
    const option = screen.getAllByRole('option').find((o) => o.title === LONG);
    if (!option) throw new Error('긴 이름 항목이 없음');
    const breaks = option.querySelectorAll('wbr');
    // 'origin/feat/…' 의 `/` 두 개 뒤
    expect(breaks).toHaveLength(2);
    expect(breaks[0]?.parentElement?.textContent).toBe(
      'origin/feat/multirepo-editor-batch1-with-a-very-long-description',
    );
  });

  it('짧은 이름·OID·HEAD·식도 알맞게 보인다', () => {
    const { rerender, onCommit, verify } = mount({ value: 'main' });
    const props = { label: S.history.compareA, refs: { head, labels }, onCommit, verify };
    expect(trigger().getAttribute('aria-label')).toBe(
      t.trigger(S.history.compareA, t.kind.local, 'main'),
    );
    rerender(<RefPicker {...props} value={'c'.repeat(40)} />);
    expect(trigger().getAttribute('aria-label')).toBe(
      t.trigger(S.history.compareA, t.kind.commit, 'cccccccc'),
    );
    rerender(<RefPicker {...props} value="HEAD" />);
    expect(trigger().getAttribute('aria-label')).toBe(
      t.trigger(S.history.compareA, '', 'HEAD main'),
    );
    rerender(<RefPicker {...props} value="HEAD~3" />);
    expect(trigger().getAttribute('aria-label')).toBe(
      t.trigger(S.history.compareA, t.kind.expression, 'HEAD~3'),
    );
  });

  it('적용한 값을 해석하지 못했으면 표시하고 설명으로 잇는다', () => {
    mount({ invalid: '찾을 수 없습니다' });
    const button = trigger();
    expect(button.dataset.invalid).toBe('true');
    const described = button.getAttribute('aria-describedby');
    expect(described && document.getElementById(described)?.textContent).toBe('찾을 수 없습니다');
  });

  it('잠겨 있으면 열리지 않고 불러오는 중이라고 알린다', () => {
    mount({ disabled: true });
    const button = trigger();
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(combobox()).toBeNull();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.title).toBe(S.history.loading);
  });
});

describe('열기와 키보드', () => {
  it('클릭·Enter·Space·↓ 로 열고 지금 값을 활성으로 둔다', () => {
    for (const open of [
      (b: HTMLElement) => fireEvent.click(b),
      (b: HTMLElement) => fireEvent.keyDown(b, { key: 'Enter' }),
      (b: HTMLElement) => fireEvent.keyDown(b, { key: ' ' }),
      (b: HTMLElement) => fireEvent.keyDown(b, { key: 'ArrowDown' }),
    ]) {
      mount();
      act(() => open(trigger()));
      const input = combobox();
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
      expect((input as HTMLInputElement).value).toBe('');
      expect(activeOption()?.getAttribute('aria-label')).toBe(
        t.option('develop', t.kind.local, false, true),
      );
      cleanup();
    }
  });

  it('글자를 치면 그 글자로 검색하며 연다', () => {
    mount();
    fireEvent.keyDown(trigger(), { key: 'f' });
    const input = combobox() as HTMLInputElement;
    expect(input.value).toBe('f');
    expect(input.selectionStart).toBe(1);
    expect(optionNames()[0]).toBe(
      t.option('feat/multirepo-editor-batch1', t.kind.local, false, false),
    );
  });

  it('해시·식 값이면 검색칸에 채워 전체 선택하고 "입력한 값 사용" 줄을 활성으로 둔다', () => {
    mount({ value: 'HEAD~3' });
    fireEvent.click(trigger());
    const input = combobox() as HTMLInputElement;
    expect(input.value).toBe('HEAD~3');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 6]);
    expect(activeOption()?.getAttribute('aria-label')).toBe(t.typedValue('HEAD~3'));
  });

  it('↑↓ 는 묶음 머리를 건너뛰며 양끝에서 멈추고, Home·End 는 검색어가 비었을 때만 목록 끝으로 간다', () => {
    mount({ value: 'HEAD' });
    fireEvent.click(trigger());
    const input = combobox() as HTMLElement;
    const names = optionNames();
    expect(names[0]).toBe(t.option('HEAD', '', false, true));
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption()?.getAttribute('aria-label')).toBe(names[0]);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption()?.getAttribute('aria-label')).toBe(names[1]);
    fireEvent.keyDown(input, { key: 'End' });
    expect(activeOption()?.getAttribute('aria-label')).toBe(names.at(-1));
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption()?.getAttribute('aria-label')).toBe(names.at(-1));
    fireEvent.keyDown(input, { key: 'Home' });
    expect(activeOption()?.getAttribute('aria-label')).toBe(names[0]);
    fireEvent.change(input, { target: { value: 'e' } });
    const first = activeOption()?.getAttribute('aria-label');
    const event = fireEvent.keyDown(input, { key: 'End' });
    expect(event).toBe(true);
    expect(activeOption()?.getAttribute('aria-label')).toBe(first);
    // 묶음 머리는 항목이 아니다
    expect(screen.getAllByRole('group').length).toBeGreaterThan(0);
    expect(names).not.toContain(t.sections.local);
  });

  it('Enter 로 고르면 전체 이름으로 확정하고 닫혀 칸으로 포커스가 돌아온다', () => {
    const { onCommit } = mount();
    fireEvent.keyDown(trigger(), { key: 'f' });
    fireEvent.keyDown(combobox() as HTMLElement, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('refs/heads/feat/multirepo-editor-batch1');
    expect(combobox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('클릭으로 고를 수 있고, 지금 값을 다시 고르면 확정하지 않고 닫기만 한다', () => {
    const { onCommit } = mount();
    fireEvent.click(trigger());
    fireEvent.click(
      screen.getByRole('option', { name: t.option('develop', t.kind.local, false, true) }),
    );
    expect(onCommit).not.toHaveBeenCalled();
    expect(combobox()).toBeNull();
    fireEvent.click(trigger());
    fireEvent.click(
      screen.getByRole('option', { name: t.option('v1.0.0', t.kind.tag, false, false) }),
    );
    expect(onCommit).toHaveBeenCalledWith('refs/tags/v1.0.0');
  });

  it('한글 조합 중의 Enter 는 고르지 않는다', () => {
    const { onCommit } = mount();
    fireEvent.click(trigger());
    const input = combobox() as HTMLElement;
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect(combobox()).not.toBeNull();
  });

  it('Esc 는 값을 그대로 두고 닫아 칸으로 돌아가며 앱 전역 키에 닿지 않는다', () => {
    const { onCommit } = mount();
    const global = vi.fn();
    window.addEventListener('keydown', global);
    fireEvent.click(trigger());
    const notPrevented = fireEvent.keyDown(combobox() as HTMLElement, { key: 'Escape' });
    window.removeEventListener('keydown', global);
    expect(notPrevented).toBe(false);
    expect(global).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(combobox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('Tab·바깥 클릭은 고르지 않고 닫는다', () => {
    const { onCommit } = mount();
    fireEvent.click(trigger());
    fireEvent.keyDown(combobox() as HTMLElement, { key: 'Tab' });
    expect(combobox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);
    expect(combobox()).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('열린 칸을 다시 누르면 닫기만 한다', () => {
    mount();
    fireEvent.click(trigger());
    fireEvent.click(trigger());
    expect(combobox()).toBeNull();
  });

  it('목록이 바뀌어도 활성 항목은 같은 ref 에 머문다', () => {
    const { rerender, onCommit, verify } = mount();
    fireEvent.click(trigger());
    fireEvent.keyDown(combobox() as HTMLElement, { key: 'ArrowDown' });
    const before = activeOption()?.getAttribute('aria-label');
    rerender(
      <RefPicker
        label={S.history.compareA}
        value="refs/heads/develop"
        refs={{ head, labels: [label('refs/heads/aaa-new'), ...labels] }}
        onCommit={onCommit}
        verify={verify}
      />,
    );
    expect(activeOption()?.getAttribute('aria-label')).toBe(before);
  });
});

describe('직접 입력', () => {
  it('확인에 성공하면 입력한 값으로 확정한다', async () => {
    const { onCommit, verify } = mount();
    fireEvent.click(trigger());
    fireEvent.change(combobox() as HTMLElement, { target: { value: 'HEAD~3' } });
    expect(activeOption()?.getAttribute('aria-label')).toBe(t.typedValue('HEAD~3'));
    await act(async () => {
      fireEvent.keyDown(combobox() as HTMLElement, { key: 'Enter' });
    });
    expect(verify).toHaveBeenCalledWith('HEAD~3');
    expect(onCommit).toHaveBeenCalledWith('HEAD~3');
    expect(combobox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('확인에 실패하면 열어 둔 채 오류를 알리고, 고쳐 쓰면 오류를 지운다', async () => {
    const verify = vi.fn<(text: string) => Promise<void>>(() => Promise.reject(new Error('bad')));
    const { onCommit } = mount({ verify });
    fireEvent.click(trigger());
    const input = combobox() as HTMLElement;
    fireEvent.change(input, { target: { value: 'nope~1' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(t.notFound('nope~1'));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    fireEvent.change(input, { target: { value: 'nope~2' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  it('확인 중에는 다시 Enter 해도 한 번만 묻고, Esc 로 닫으면 늦게 온 성공을 버린다', async () => {
    let resolve: () => void = () => {};
    const verify = vi.fn<(text: string) => Promise<void>>(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { onCommit } = mount({ verify });
    fireEvent.click(trigger());
    const input = combobox() as HTMLElement;
    fireEvent.change(input, { target: { value: 'abc1234' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toBe(t.checking);
    fireEvent.keyDown(input, { key: 'Escape' });
    await act(async () => {
      resolve();
    });
    expect(onCommit).not.toHaveBeenCalled();
    expect(combobox()).toBeNull();
  });

  it('일치하는 ref 가 없으면 안내하고 "입력한 값 사용" 줄만 남긴다', () => {
    mount();
    fireEvent.click(trigger());
    fireEvent.change(combobox() as HTMLElement, { target: { value: 'zzzzqqq' } });
    expect(screen.getByText(t.noMatch)).not.toBeNull();
    expect(optionNames()).toEqual([t.typedValue('zzzzqqq')]);
  });

  it('저장소에 ref 가 없으면 커밋·식을 입력하라고 안내한다', () => {
    mount({ value: 'HEAD', refs: { head, labels: [] } });
    fireEvent.click(trigger());
    expect(screen.getByText(t.noRefs)).not.toBeNull();
    expect(optionNames()).toEqual([t.option('HEAD', '', false, true)]);
  });
});

describe('목록 구성', () => {
  it('stash 는 목록에 없고, 현재 브랜치에는 "현재" 가 붙는다', () => {
    mount();
    fireEvent.click(trigger());
    const names = optionNames();
    expect(names.some((n) => n?.startsWith('stash'))).toBe(false);
    const main = screen.getByRole('option', { name: t.option('main', t.kind.local, true, false) });
    expect(main.textContent).toContain(t.current);
    expect(main.dataset.current).toBe('true');
  });

  it('대상 칸은 "현재 로컬 내용" 을 맨 위에 두고 고르면 그 값으로 확정한다', () => {
    const { onCommit } = mount({ label: S.history.compareB, value: 'refs/heads/main', local });
    fireEvent.click(trigger());
    const names = optionNames();
    expect(names[0]).toBe(t.option(S.comparison.localContent, '', false, false));
    expect(names[1]).toBe(t.option('HEAD', '', false, false));
    fireEvent.keyDown(combobox() as HTMLElement, { key: 'Home' });
    fireEvent.keyDown(combobox() as HTMLElement, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(LOCAL);
  });

  it('값이 "현재 로컬 내용" 이면 닫힌 칸에 그 글자를 보인다', () => {
    mount({ label: S.history.compareB, value: LOCAL, local });
    expect(trigger().getAttribute('aria-label')).toBe(
      t.trigger(S.history.compareB, '', S.comparison.localContent),
    );
  });

  it('검색칸·목록의 접근성 연결이 실제 요소를 가리킨다', () => {
    mount();
    fireEvent.click(trigger());
    const input = combobox() as HTMLElement;
    expect(input.getAttribute('aria-label')).toBe(t.search(S.history.compareA));
    const list = document.getElementById(input.getAttribute('aria-controls') ?? '');
    expect(list?.getAttribute('role')).toBe('listbox');
    expect(activeOption()?.getAttribute('role')).toBe('option');
    expect(activeOption()?.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('dialog', { name: S.history.compareA })).not.toBeNull();
  });
});
