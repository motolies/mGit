import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useRovingToolbar } from '../components/roving';

afterEach(cleanup);

/** 동적으로 숨겨지거나 비활성화되는 컨트롤의 실제 포커스를 검사한다. */
function Fixture({
  disabled = false,
  hidden = false,
  remove = false,
}: {
  disabled?: boolean;
  hidden?: boolean;
  remove?: boolean;
}) {
  const roving = useRovingToolbar<HTMLDivElement>('horizontal');
  return (
    <>
      <div role="toolbar" ref={roving.ref} onFocus={roving.onFocus} onKeyDown={roving.onKeyDown}>
        {!remove && (
          <button type="button" disabled={disabled} hidden={hidden}>
            first
          </button>
        )}
        <button type="button">second</button>
        <input aria-label="field" defaultValue="abc" />
        <select aria-label="choice">
          <option>one</option>
          <option>two</option>
        </select>
      </div>
      <button type="button">outside</button>
    </>
  );
}

describe('공통 도구 모음 조작', () => {
  it('버튼 방향키 이동은 입력·선택창을 가로채지 않는다', () => {
    render(<Fixture />);
    screen.getByText('first').focus();
    fireEvent.keyDown(screen.getByText('first'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByText('second'));
    const input = screen.getByLabelText('field');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(input);
    const select = screen.getByLabelText('choice');
    select.focus();
    fireEvent.keyDown(select, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(select);
  });
  it('숨은 버튼의 옛 Tab 정지를 제거하고 사라진 포커스는 그룹에 둔다', () => {
    const { rerender } = render(<Fixture />);
    screen.getByText('first').focus();
    rerender(<Fixture disabled />);
    expect(screen.getByText('first').tabIndex).toBe(-1);
    expect(document.activeElement).toBe(screen.getByRole('toolbar'));
    rerender(<Fixture />);
    screen.getByText('first').focus();
    rerender(<Fixture hidden />);
    expect(screen.getByText('first').tabIndex).toBe(-1);
    expect(document.activeElement).toBe(screen.getByRole('toolbar'));
    rerender(<Fixture />);
    expect(document.activeElement).toBe(screen.getByText('first'));
    rerender(<Fixture remove />);
    expect(document.activeElement).toBe(screen.getByRole('toolbar'));
  });
  it('이미 다른 영역에 옮긴 포커스는 비활성화 후에도 유지한다', () => {
    const { rerender } = render(<Fixture />);
    screen.getByText('first').focus();
    screen.getByText('outside').focus();
    rerender(<Fixture disabled />);
    expect(document.activeElement).toBe(screen.getByText('outside'));
  });
});
