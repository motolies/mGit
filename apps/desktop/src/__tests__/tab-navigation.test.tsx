import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { TabListMenu, useRevealActiveTab } from '../components/tab-navigation';

/** 탭 선택과 가로 노출만 분리해서 검사한다. */
function Fixture({ active }: { active: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useRevealActiveTab(ref, active);
  return (
    <>
      <button type="button">outside</button>
      <div ref={ref} data-testid="viewport">
        <button type="button" role="tab" aria-selected={active === 'a'}>
          a
        </button>
        <button type="button" role="tab" aria-selected={active === 'b'}>
          b
        </button>
      </div>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('외부 명령으로 활성 탭이 바뀌면 가로로 드러내며 본문 포커스는 유지한다', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const left = this.textContent === 'b' ? 240 : 0;
    return {
      left,
      right: left + 100,
      top: 0,
      bottom: 30,
      width: 100,
      height: 30,
      x: left,
      y: 0,
      toJSON: () => ({}),
    };
  });
  const { rerender } = render(<Fixture active="a" />);
  const origin = screen.getByText('outside');
  origin.focus();
  rerender(<Fixture active="b" />);
  expect(screen.getByTestId('viewport').scrollLeft).toBe(240);
  expect(document.activeElement).toBe(origin);
});

it('열린 탭 메뉴에는 생략되지 않은 제목이 있고 선택한 문서로 이동한다', async () => {
  const select = vi.fn();
  render(
    <TabListMenu
      label="All tabs"
      items={[
        { id: 'a', title: 'first / full path' },
        { id: 'b', title: 'second / full path' },
      ]}
      active="a"
      select={select}
    />,
  );
  fireEvent.keyDown(screen.getByRole('button', { name: 'All tabs' }), { key: 'ArrowDown' });
  const target = await screen.findByRole('menuitemradio', { name: 'second / full path' });
  fireEvent.click(target);
  expect(select).toHaveBeenCalledWith('b');
});
